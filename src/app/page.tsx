"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Download,
  FileText,
  GitCommitHorizontal,
  GitFork,
  History,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  TrendingUp,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsDialog } from "@/components/settings-dialog";
import { SiteHero } from "@/components/site-hero";
import { SiteFooter } from "@/components/site-footer";
import { GithubMark } from "@/components/github-mark";
import { REPO_URL } from "@/lib/site";
import { ContributorNetwork } from "@/components/contributor-network";
import { BranchMultiSelect } from "@/components/branch-multi-select";
import { EstimatePanel } from "@/components/estimate-panel";
import { AnalysisCoverage } from "@/components/analysis-coverage";
import { CommitHeatmap, RecentCommitHeatmap } from "@/components/commit-heatmap";
import { cn } from "@/lib/utils";
import {
  ANALYZE_BATCH_SIZE,
  MAX_ANALYZE_COMMITS,
  MAX_BRANCHES,
  RANGE_DAY_OPTIONS,
} from "@/lib/limits";
import { runAnalyze, splitBatches, type AnalyzeProgress } from "@/lib/analyze-client";
import { runEstimate as runEstimateBatches } from "@/lib/estimate-client";
import { buildReportDetails, shortDay } from "@/lib/report-details";
import {
  DEFAULT_PRICING,
  computeQuote,
  defaultHours,
  formatMoney,
  normalizePricing,
  toExportQuote,
} from "@/lib/pricing";
import {
  CATEGORY_META,
  IMPACT_META,
  downloadFile,
  reportToMarkdown,
  reportToText,
  reportToWordHtml,
} from "@/lib/present";
import type {
  AiSettings,
  AnalyzeResult,
  CommitItem,
  EstimateResult,
  PricingSettings,
  RepoInfo,
} from "@/lib/types";

const DEFAULT_AI_SETTINGS: AiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  rangeDays: 7,
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return "";
  }
}

/** 按 SHA 合并提交，合并所属分支，结果按时间倒序 */
function mergeCommits(prev: CommitItem[], incoming: CommitItem[]): CommitItem[] {
  const map = new Map(prev.map((c) => [c.sha, c]));
  for (const c of incoming) {
    const existing = map.get(c.sha);
    if (existing) {
      map.set(c.sha, {
        ...existing,
        branches: [
          ...new Set([...(existing.branches ?? []), ...(c.branches ?? [])]),
        ],
      });
    } else {
      map.set(c.sha, c);
    }
  }
  return [...map.values()].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );
}

function authorOf(c: CommitItem): string {
  return c.author || "未知";
}

function persistSettings(s: AiSettings) {
  localStorage.setItem("c2v-ai-settings", JSON.stringify(s));
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
      {n}
    </span>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

export default function Home() {
  // 仓库状态
  const [repoInput, setRepoInput] = useState("");
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  // 提交状态
  const [branches, setBranches] = useState<string[]>([]);
  const [commits, setCommits] = useState<CommitItem[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  // 部分分支读取失败时的提示（其余分支结果照常展示）
  const [commitWarnings, setCommitWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 作者筛选（"" = 全部作者），仅在前端过滤已加载的提交
  const [authorFilter, setAuthorFilter] = useState("");

  // 提交分页（每个分支独立游标，null = 已到底）/ 分组折叠
  const [cursors, setCursors] = useState<Record<string, number | null>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const hasMore = Object.values(cursors).some((p) => p !== null);

  // 分析状态
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // 分批分析进度 / 合并降级等非致命提示 / 取消用的控制器
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null);
  const [analyzeWarning, setAnalyzeWarning] = useState<string | null>(null);
  const analyzeAbort = useRef<AbortController | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [expandedCard, setExpandedCard] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  // 客户汇报：支持编辑，reportOverride 为用户改写后的纯文本（null = 用 AI 原文）
  const [reportOverride, setReportOverride] = useState<string | null>(null);
  const [editingReport, setEditingReport] = useState(false);
  // 右栏页签：achievements=成果依据明细；report=客户版汇报（核心输出，默认直达）
  const [rightTab, setRightTab] = useState<
    "achievements" | "report" | "estimate"
  >("achievements");
  // 本次分析实际送入的提交（估算时用；分析后用户可能又改了勾选）
  const [analyzedCommits, setAnalyzedCommits] = useState<CommitItem[]>([]);

  // 估时报价
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [estimateHours, setEstimateHours] = useState<Record<number, number>>({});
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  // 导出客户汇报时是否附带工时与报价（成本永不导出）
  const [includeQuote, setIncludeQuote] = useState(false);
  // 导出与预览是否附带工作明细、按周进展与热力图（前端推导，不消耗 AI）
  const [includeDetails, setIncludeDetails] = useState(true);

  // 设置状态
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  // 当前仓库所属平台：加载成功后按仓库返回结果锁定，避免中途切平台导致数据错乱
  const [loadedProvider, setLoadedProvider] = useState<
    "github" | "gitlab" | null
  >(null);
  const repoProvider = loadedProvider ?? aiSettings.provider ?? "github";

  useEffect(() => {
    try {
      const saved = localStorage.getItem("c2v-ai-settings");
      if (saved) {
        setAiSettings({ ...DEFAULT_AI_SETTINGS, ...JSON.parse(saved) });
      }
    } catch {
      // ignore
    }
  }, []);

  const loadRepo = useCallback(
    async (input: string) => {
      setRepoError(null);
      setRepoLoading(true);
      setResult(null);
      setAnalyzeError(null);
      try {
        const res = await fetch("/api/github/repo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoInput: input,
            ghBaseUrl: aiSettings.ghBaseUrl,
            ghToken: aiSettings.ghToken,
            provider: repoProvider,
            glBaseUrl: aiSettings.glBaseUrl,
            glToken: aiSettings.glToken,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setRepoError(data.error || "加载仓库失败");
          setRepo(null);
          setCommits([]);
          return;
        }
        const info: RepoInfo = data;
        setRepo(info);
        setBranches([info.defaultBranch]);
        setAuthorFilter("");
        setLoadedProvider(info.provider ?? aiSettings.provider ?? "github");
      } catch {
        setRepoError("网络错误，请稍后重试");
      } finally {
        setRepoLoading(false);
      }
    },
    // 必须依赖 ghBaseUrl / ghToken：否则用户在设置里填入 PAT 后，
    // 这里仍会闭包捕获首次渲染时的空 token，导致私有仓库请求不带认证。
    [
      aiSettings.ghBaseUrl,
      aiSettings.ghToken,
      aiSettings.glBaseUrl,
      aiSettings.glToken,
      aiSettings.provider,
    ]
  );

  // 分析结果变化（重新拉取 / 重新分析）时，旧估算的下标已对不上，一并清空
  const resetEstimate = useCallback(() => {
    setEstimate(null);
    setEstimateHours({});
    setEstimateError(null);
    setIncludeQuote(false);
  }, []);

  const commitsRequestBase = useMemo(
    () =>
      repo
        ? {
            owner: repo.owner,
            name: repo.name,
            rangeDays: aiSettings.rangeDays ?? 7,
            ghBaseUrl: aiSettings.ghBaseUrl,
            ghToken: aiSettings.ghToken,
            provider: repoProvider,
            glBaseUrl: aiSettings.glBaseUrl,
            glToken: aiSettings.glToken,
          }
        : null,
    [
      repo,
      repoProvider,
      aiSettings.rangeDays,
      aiSettings.ghBaseUrl,
      aiSettings.ghToken,
      aiSettings.glBaseUrl,
      aiSettings.glToken,
    ]
  );

  useEffect(() => {
    if (!commitsRequestBase || branches.length === 0) return;
    let cancelled = false;
    (async () => {
      setCommitsLoading(true);
      setCommitsError(null);
      setCommitWarnings([]);
      setCommits([]);
      setSelected(new Set());
      setCursors({});
      setCollapsed(new Set());
      setAuthorFilter("");
      setResult(null);
      setAnalyzeError(null);
      resetEstimate();
      try {
        const res = await fetch("/api/github/commits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...commitsRequestBase, branches }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setCommitsError(data.error || "获取提交失败");
          return;
        }
        const list: CommitItem[] = data.commits ?? [];
        setCommits(list);
        setCursors(data.cursors ?? {});
        setCommitWarnings(data.warnings ?? []);
        // 默认选中最新的一批（单次请求即可完成），需要更多时由用户全选，按批分析
        setSelected(new Set(list.slice(0, ANALYZE_BATCH_SIZE).map((c) => c.sha)));
      } catch {
        if (!cancelled) setCommitsError("网络错误，请稍后重试");
      } finally {
        if (!cancelled) setCommitsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitsRequestBase, branches, resetEstimate]);

  const loadMore = useCallback(async () => {
    if (!commitsRequestBase || loadingMore) return;
    const pages = Object.fromEntries(
      Object.entries(cursors).filter(([, p]) => p !== null)
    );
    if (Object.keys(pages).length === 0) return;
    setLoadingMore(true);
    try {
      const res = await fetch("/api/github/commits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...commitsRequestBase, pages }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCommitsError(data.error || "加载更多提交失败");
        return;
      }
      const list: CommitItem[] = data.commits ?? [];
      setCommits((prev) => mergeCommits(prev, list));
      setCursors((prev) => ({ ...prev, ...(data.cursors ?? {}) }));
      if (data.warnings?.length) {
        setCommitWarnings((prev) => [...prev, ...data.warnings]);
      }
      // 新加载且符合当前作者筛选的提交默认选中，但不超过一批的数量
      setSelected((prev) => {
        const next = new Set(prev);
        for (const c of list) {
          if (next.size >= ANALYZE_BATCH_SIZE) break;
          if (!authorFilter || authorOf(c) === authorFilter) next.add(c.sha);
        }
        return next;
      });
    } catch {
      setCommitsError("网络错误，请稍后重试");
    } finally {
      setLoadingMore(false);
    }
  }, [commitsRequestBase, cursors, loadingMore, authorFilter]);

  /** 确认分支选择：集合未变时不触发重新拉取 */
  function applyBranches(next: string[]) {
    if (next.length === 0) return;
    if (next.join("\n") === branches.join("\n")) return;
    setBranches(next);
  }

  /** 「最近所有工作」：选中全部分支（超出上限时取默认分支 + 列表前若干个） */
  function selectAllBranches() {
    if (!repo) return;
    const ordered = [
      repo.defaultBranch,
      ...repo.branches.filter((b) => b !== repo.defaultBranch),
    ];
    applyBranches(ordered.slice(0, MAX_BRANCHES));
  }

  // 作者筛选后的可见提交：列表、统计、分析均基于它
  const visibleCommits = useMemo(
    () =>
      authorFilter ? commits.filter((c) => authorOf(c) === authorFilter) : commits,
    [commits, authorFilter]
  );

  const authorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of commits) m.set(authorOf(c), (m.get(authorOf(c)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [commits]);

  /** 切换作者：选中集重置为该作者最新的若干条，保证「已选」始终是可见提交的子集 */
  function changeAuthor(next: string) {
    setAuthorFilter(next);
    const list = next ? commits.filter((c) => authorOf(c) === next) : commits;
    setSelected(new Set(list.slice(0, ANALYZE_BATCH_SIZE).map((c) => c.sha)));
  }

  const selectedCount = useMemo(
    () => visibleCommits.filter((c) => selected.has(c.sha)).length,
    [visibleCommits, selected]
  );
  const overAnalyzeLimit = selectedCount > MAX_ANALYZE_COMMITS;
  // 超过一批时将拆批分析，提前告知批数
  const batchCount =
    selectedCount > ANALYZE_BATCH_SIZE && !overAnalyzeLimit
      ? splitBatches(new Array(selectedCount).fill(0)).length
      : 1;

  const allSelected =
    visibleCommits.length > 0 && visibleCommits.every((c) => selected.has(c.sha));

  function toggleCommit(sha: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }

  function toggleAll() {
    setSelected(
      allSelected ? new Set() : new Set(visibleCommits.map((c) => c.sha))
    );
  }

  // 按日期分组（日期倒序），用于折叠展示
  const grouped = useMemo(() => {
    const sorted = [...visibleCommits].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );
    const map = new Map<string, CommitItem[]>();
    for (const c of sorted) {
      const d = formatDate(c.date);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(c);
    }
    return Array.from(map.entries());
  }, [visibleCommits]);

  // 每日提交数（用于顶部极简趋势柱）
  const trend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visibleCommits) {
      const d = formatDate(c.date);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const items = visibleCommits.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const seen = new Set<string>();
    const arr: Array<[string, number]> = [];
    for (const c of items) {
      const d = formatDate(c.date);
      if (!seen.has(d)) {
        seen.add(d);
        arr.push([d, counts.get(d) ?? 0]);
      }
    }
    const max = Math.max(1, ...arr.map(([, n]) => n));
    return { arr, max };
  }, [visibleCommits]);

  function toggleGroupCollapse(date: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  function toggleGroup(date: string, groupCommits: CommitItem[]) {
    const allIn = groupCommits.every((c) => selected.has(c.sha));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allIn) groupCommits.forEach((c) => next.delete(c.sha));
      else groupCommits.forEach((c) => next.add(c.sha));
      return next;
    });
  }

  function groupAllSelected(groupCommits: CommitItem[]) {
    return (
      groupCommits.length > 0 && groupCommits.every((c) => selected.has(c.sha))
    );
  }

  // 本地统计（不依赖 AI），用于顶部总览卡片；随作者筛选变化
  const localStats = useMemo(() => {
    const authors = new Map<string, number>();
    for (const c of visibleCommits) {
      const k = authorOf(c);
      authors.set(k, (authors.get(k) ?? 0) + 1);
    }
    return {
      commitCount: visibleCommits.length,
      contributorCount: authors.size,
      topContributors: [...authors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => ({ name, count })),
      days: new Set(visibleCommits.map((c) => formatDate(c.date))).size,
    };
  }, [visibleCommits]);

  const analyze = useCallback(async () => {
    const chosen = visibleCommits.filter((c) => selected.has(c.sha));
    if (!repo || chosen.length === 0 || chosen.length > MAX_ANALYZE_COMMITS) return;
    const controller = new AbortController();
    analyzeAbort.current = controller;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeWarning(null);
    setAnalyzeProgress(null);
    try {
      const outcome = await runAnalyze(
        {
          repo: repo.fullName,
          owner: repo.owner,
          name: repo.name,
          branches,
          commits: chosen,
          settings: { ...aiSettings, provider: repoProvider },
        },
        { signal: controller.signal, onProgress: setAnalyzeProgress }
      );
      if (!outcome.ok) {
        // 用户主动取消时保留上一次的结果，不显示错误
        if (!outcome.aborted) setAnalyzeError(outcome.error);
        if (outcome.code === "AI_NOT_CONFIGURED") setSettingsOpen(true);
        return;
      }
      setResult(outcome.result);
      setAnalyzeWarning(outcome.warning ?? null);
      setAnalyzedCommits(chosen);
      resetEstimate();
      setExpandedCard(new Set());
      setReportOverride(null);
      setEditingReport(false);
      // 分析完成后自动切到「客户汇报」页签：
      // 汇报是核心产出，不该让用户翻过长长的依据列表才能看到。
      setRightTab("report");
    } finally {
      if (analyzeAbort.current === controller) analyzeAbort.current = null;
      setAnalyzing(false);
      setAnalyzeProgress(null);
    }
  }, [repo, branches, visibleCommits, selected, aiSettings, repoProvider, resetEstimate]);

  const progressText =
    !analyzeProgress || analyzeProgress.phase === "analyze"
      ? "正在分析…"
      : analyzeProgress.phase === "context"
        ? "正在读取项目文档…"
        : analyzeProgress.phase === "merge"
          ? "正在合并各批成果…"
          : `正在分析第 ${Math.min(analyzeProgress.done + 1, analyzeProgress.total)}/${analyzeProgress.total} 批…`;

  // ---- 估时报价 ----
  // pricingDraft 保留用户输入原值（便于清空后重新输入），计算时再归一化
  const pricingDraft: PricingSettings = useMemo(
    () => ({ ...DEFAULT_PRICING, ...aiSettings.pricing }),
    [aiSettings.pricing]
  );
  const pricing = useMemo(() => normalizePricing(pricingDraft), [pricingDraft]);

  function changeRangeDays(days: number) {
    if (days === (aiSettings.rangeDays ?? 7)) return;
    setAiSettings((prev) => {
      const s = { ...prev, rangeDays: days };
      persistSettings(s);
      return s;
    });
  }

  function updatePricing(next: PricingSettings) {
    setAiSettings((prev) => {
      const s = { ...prev, pricing: next };
      persistSettings(s);
      return s;
    });
  }

  const runEstimate = useCallback(async () => {
    if (!repo || !result) return;
    setEstimating(true);
    setEstimateError(null);
    try {
      // 成果较多时由 estimate-client 拆批请求（子任务拆分让单条输出变长）
      const outcome = await runEstimateBatches({
        repo: repo.fullName,
        achievements: result.achievements,
        commits: analyzedCommits,
        evidence: result.evidence ?? [],
        projectContext: result.context?.text || undefined,
        // 估算只需要 AI 配置，不携带代码平台令牌
        settings: {
          baseUrl: aiSettings.baseUrl,
          apiKey: aiSettings.apiKey,
          model: aiSettings.model,
        },
      });
      if (!outcome.ok) {
        setEstimateError(outcome.error);
        if (outcome.code === "AI_NOT_CONFIGURED") setSettingsOpen(true);
        return;
      }
      const est: EstimateResult = outcome.result;
      setEstimate(est);
      setEstimateHours(
        Object.fromEntries(est.items.map((it) => [it.index, defaultHours(it)]))
      );
    } finally {
      setEstimating(false);
    }
  }, [
    repo,
    result,
    analyzedCommits,
    aiSettings.baseUrl,
    aiSettings.apiKey,
    aiSettings.model,
  ]);

  const quoteSummary = useMemo(
    () =>
      estimate && result
        ? computeQuote(
            result.achievements.map((a, i) => ({
              index: i,
              title: a.title,
              hours: estimateHours[i] ?? 0,
              tasks: estimate.items.find((it) => it.index === i)?.tasks,
            })),
            pricing
          )
        : null,
    [estimate, result, estimateHours, pricing]
  );
  const exportQuote = useMemo(
    () =>
      includeQuote && quoteSummary ? toExportQuote(quoteSummary, pricing) : undefined,
    [includeQuote, quoteSummary, pricing]
  );

  function toggleEvidence(i: number) {
    setExpandedCard((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // 详细章节基于本次实际分析的提交（不是当前列表），与报告覆盖范围一致
  const reportDetails = useMemo(
    () => (result ? buildReportDetails(result.achievements, analyzedCommits) : null),
    [result, analyzedCommits]
  );
  const exportDetails = includeDetails && reportDetails ? reportDetails : undefined;

  /** 汇报纯文本（用户编辑优先，否则用 AI 生成内容） */
  const plainReport = useMemo(
    () =>
      reportToText(result?.report ?? { summary: "", items: [], nextSteps: "" }, {
        repo: repo?.fullName,
        quote: exportQuote,
        details: exportDetails,
      }),
    [result, repo, exportQuote, exportDetails]
  );

  async function copyText(text: string, tag: string, fallbackId?: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      const ta = fallbackId
        ? (document.getElementById(fallbackId) as HTMLTextAreaElement | null)
        : null;
      if (ta) {
        ta.focus();
        ta.select();
      }
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50/70 via-background to-background">
      <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        {/* 顶部 */}
        <header className="flex items-center justify-between py-6">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <Code2 className="size-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Commit2Value
              </h1>
              <p className="text-sm text-muted-foreground">
                把代码变成客户看得懂的成果汇报
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" asChild>
              <a href={REPO_URL} target="_blank" rel="noreferrer" title="在 GitHub 上查看源码">
                <GithubMark />
                <span className="hidden sm:inline">GitHub 开源</span>
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-5" />
            </Button>
          </div>
        </header>

        {/* 主题、主要功能与开源地址；加载仓库后只保留流程条 */}
        <SiteHero
          showFeatures={!repo}
          onStart={() => {
            const el = document.getElementById("repo-input");
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
            el?.focus({ preventScroll: true });
          }}
        />

        <div className="grid items-start gap-6 lg:grid-cols-2">
          {/* ============ 左栏 ============ */}
          <div className="space-y-6">
            {/* ① 选择仓库 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2.5 text-base">
                  <StepNumber n={1} /> 选择仓库
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (repoInput.trim()) loadRepo(repoInput);
                  }}
                >
                  <Input
                    id="repo-input"
                    placeholder={
                      repoProvider === "gitlab"
                        ? "例如：gitlab-org/my-project（支持嵌套子组）"
                        : "例如：facebook/react 或粘贴仓库地址"
                    }
                    value={repoInput}
                    onChange={(e) => setRepoInput(e.target.value)}
                    aria-label={repoProvider === "gitlab" ? "GitLab 项目地址" : "GitHub 仓库地址"}
                  />
                  <Button type="submit" disabled={repoLoading || !repoInput.trim()}>
                    {repoLoading ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Search />
                    )}
                    加载
                  </Button>
                </form>

                {repoError && <ErrorNote text={repoError} />}

                {!repo && !repoError && (
                  <p className="text-sm text-muted-foreground">
                    支持 GitHub 与 GitLab（含自建）。读取分支和所选时间范围内的提交。
                  </p>
                )}

                {repo && (
                  <div className="rounded-xl border bg-muted/40 p-3">
                    <div className="flex items-center gap-2">
                      <GitFork className="size-4 shrink-0" />
                      <span className="truncate font-semibold">
                        {repo.fullName}
                      </span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <BranchMultiSelect
                        branches={repo.branches}
                        defaultBranch={repo.defaultBranch}
                        value={branches}
                        max={MAX_BRANCHES}
                        onChange={applyBranches}
                      />
                      {repo.branches.length > 1 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={selectAllBranches}
                          disabled={commitsLoading}
                          title="选中全部分支，可再按作者筛选"
                        >
                          <History />
                          最近所有工作
                        </Button>
                      )}
                      {/* 时间范围快捷切换：改动会保存到设置并自动重新拉取提交 */}
                      <div
                        role="radiogroup"
                        aria-label="统计时间范围"
                        className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5 text-xs"
                      >
                        <Clock className="mx-1 size-3 text-muted-foreground" />
                        {RANGE_DAY_OPTIONS.map((d) => {
                          const active = (aiSettings.rangeDays ?? 7) === d;
                          return (
                            <button
                              key={d}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              disabled={commitsLoading}
                              onClick={() => changeRangeDays(d)}
                              className={cn(
                                "rounded px-2 py-1 transition-colors disabled:opacity-50",
                                active
                                  ? "bg-background font-medium text-foreground shadow-xs"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              {d} 天
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {repo.branches.length > MAX_BRANCHES &&
                      branches.length === MAX_BRANCHES && (
                        <p className="mt-2 text-xs text-amber-600">
                          仓库共 {repo.branches.length} 个分支，单次最多读取 {MAX_BRANCHES} 个，未选中的分支不会纳入统计。
                        </p>
                      )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ② 选择提交 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2.5 text-base">
                  <StepNumber n={2} /> 选择提交
                </CardTitle>
                <CardAction className="text-sm text-muted-foreground">
                  {commits.length > 0 && !commitsLoading && (
                    <span className={cn(overAnalyzeLimit && "text-red-600")}>
                      已选 {selectedCount} / {MAX_ANALYZE_COMMITS}
                    </span>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-2">
                {!repo && (
                  <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                    先在上方加载一个仓库
                  </div>
                )}

                {repo && commitsLoading && (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="flex items-start gap-3 rounded-xl border p-3"
                      >
                        <Skeleton className="size-4 rounded-full" />
                        <div className="flex-1 space-y-1.5">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-3 w-1/2" />
                        </div>
                        <Skeleton className="h-5 w-14" />
                      </div>
                    ))}
                  </div>
                )}

                {commitsError && <ErrorNote text={commitsError} />}

                {commitWarnings.length > 0 && (
                  <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                    {commitWarnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </div>
                )}

                {repo && !commitsLoading && !commitsError && commits.length === 0 && (
                  <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {branches.length === 1
                      ? `分支「${branches[0]}」`
                      : `所选 ${branches.length} 个分支`}
                    最近 {aiSettings.rangeDays ?? 7} 天没有提交，试试切换分支或其他时间段。
                  </div>
                )}

                {/* 作者筛选：配合「最近所有工作」只看某个人的提交 */}
                {repo && !commitsLoading && authorCounts.length > 1 && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="shrink-0 text-muted-foreground">作者</span>
                    <select
                      value={authorFilter}
                      onChange={(e) => changeAuthor(e.target.value)}
                      aria-label="按作者筛选"
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <option value="">全部作者（{commits.length}）</option>
                      {authorCounts.map(([name, count]) => (
                        <option key={name} value={name}>
                          {name}（{count}）
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* 极简每日提交趋势 */}
                {repo && !commitsLoading && !commitsError && visibleCommits.length > 0 && (
                  <div className="flex items-end gap-1.5 rounded-xl border bg-muted/30 p-3">
                    {trend.arr.map(([d, n]) => (
                      <div
                        key={d}
                        className="flex flex-1 flex-col items-center gap-1"
                      >
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {n}
                        </span>
                        <div
                          className="w-full rounded-sm bg-primary/70"
                          style={{
                            height: `${Math.max(6, (n / trend.max) * 36)}px`,
                          }}
                          title={`${d}：${n} 次提交`}
                        />
                        <span className="text-[9px] text-muted-foreground/70">
                          {d.replace("月", "/").replace("日", "")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 按日期分组的提交列表 */}
                {grouped.map(([date, groupCommits]) => {
                  const isCollapsed = collapsed.has(date);
                  const gAll = groupAllSelected(groupCommits);
                  return (
                    <div key={date} className="space-y-2">
                      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggleGroupCollapse(date)}
                          className="flex items-center gap-1.5 text-sm font-medium"
                        >
                          <ChevronDown
                            className={cn(
                              "size-4 text-muted-foreground transition-transform",
                              isCollapsed && "-rotate-90"
                            )}
                          />
                          {date}
                          <span className="text-xs text-muted-foreground">
                            （{groupCommits.length}）
                          </span>
                        </button>
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox
                            checked={gAll}
                            onCheckedChange={() => toggleGroup(date, groupCommits)}
                          />
                          全选本日
                        </label>
                      </div>
                      {!isCollapsed &&
                        groupCommits.map((c) => {
                          const checked = selected.has(c.sha);
                          return (
                            <label
                              key={c.sha}
                              className={cn(
                                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-accent/60",
                                checked
                                  ? "border-primary/30 bg-emerald-50/70"
                                  : "bg-card"
                              )}
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={checked}
                                onCheckedChange={() => toggleCommit(c.sha)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold">
                                  {c.title}
                                </div>
                                {c.description && (
                                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {c.description}
                                  </div>
                                )}
                                {(!!c.author ||
                                  (branches.length > 1 && !!c.branches?.length)) && (
                                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground/80">
                                    {c.author && (
                                      <>
                                        <span className="inline-block size-1.5 rounded-full bg-primary/60" />
                                        {c.author}
                                      </>
                                    )}
                                    {branches.length > 1 &&
                                      c.branches?.map((b) => (
                                        <span
                                          key={b}
                                          className="rounded border bg-muted/50 px-1 font-mono text-[10px]"
                                        >
                                          {b}
                                        </span>
                                      ))}
                                  </div>
                                )}
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-0.5">
                                <Badge
                                  variant="secondary"
                                  className="font-mono text-[11px] font-normal"
                                >
                                  {c.shortSha}
                                </Badge>
                                <span className="text-[11px] text-muted-foreground">
                                  {formatDate(c.date)}
                                </span>
                              </div>
                            </label>
                          );
                        })}
                    </div>
                  );
                })}

                {/* 加载更多 */}
                {repo && !commitsLoading && !commitsError && hasMore && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? <Loader2 className="animate-spin" /> : null}
                    {loadingMore ? "加载中…" : "加载更多提交"}
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* 悬浮批量操作栏：长列表时无需滚动到底即可操作 */}
            {repo && visibleCommits.length > 0 && !commitsLoading && !commitsError && (
              <div className="sticky bottom-3 z-20 flex flex-col gap-3 rounded-2xl border bg-background/90 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                    全选（已选 {selectedCount} 个提交）
                  </label>
                  {overAnalyzeLimit && (
                    <p className="text-xs text-red-600">
                      单次最多分析 {MAX_ANALYZE_COMMITS} 个提交，请取消勾选{" "}
                      {selectedCount - MAX_ANALYZE_COMMITS} 个
                    </p>
                  )}
                  {batchCount > 1 && (
                    <p className="text-xs text-amber-600">
                      超过 {ANALYZE_BATCH_SIZE} 个，将分 {batchCount} 批分析后合并，耗时与 AI
                      用量随批数增加
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {analyzing && (
                    <Button
                      size="lg"
                      variant="outline"
                      onClick={() => analyzeAbort.current?.abort()}
                    >
                      取消
                    </Button>
                  )}
                  <Button
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={analyze}
                    disabled={analyzing || selectedCount === 0 || overAnalyzeLimit}
                  >
                    {analyzing ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Sparkles />
                    )}
                    {analyzing ? progressText : "分析选中的提交"}
                    {!analyzing && <ArrowRight className="ml-1" />}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ============ 右栏 ============ */}
          <div className="space-y-6">
            {/* 数据总览（本地统计，AI 分析前也有） */}
            {repo && visibleCommits.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2.5 text-base">
                    <BarChart3 className="size-4 text-primary" />
                    本期工作量
                  </CardTitle>
                  <CardAction className="text-xs text-muted-foreground">
                    最近 {localStats.days} 天有提交
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: "提交数", value: localStats.commitCount },
                      { label: "参与人", value: localStats.contributorCount },
                      { label: "代码新增", value: result?.stats?.additions ?? "—" },
                      { label: "代码删除", value: result?.stats?.deletions ?? "—" },
                    ].map((s) => (
                      <div
                        key={s.label}
                        className="rounded-xl border bg-muted/30 p-3 text-center"
                      >
                        <div className="text-xl font-bold text-primary">
                          {s.value}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {s.label}
                        </div>
                      </div>
                    ))}
                  </div>
                  {localStats.topContributors.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>主要贡献：</span>
                      {localStats.topContributors.map((c) => (
                        <Badge key={c.name} variant="secondary" className="font-normal">
                          {c.name} · {c.count}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* 提交热力图：统计已加载（且经作者筛选）的提交 */}
                  <div className="mt-4 border-t pt-3">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      提交活跃度
                    </p>
                    <RecentCommitHeatmap
                      commits={visibleCommits}
                      rangeDays={Math.min(Math.max(aiSettings.rangeDays ?? 7, 1), 90)}
                      partial={hasMore}
                    />
                  </div>

                  {/* 贡献者协作网络图 */}
                  {localStats.contributorCount > 1 && (
                    <div className="mt-4 border-t pt-3">
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                        贡献者协作网络
                      </p>
                      <div className="flex justify-center">
                        <ContributorNetwork commits={visibleCommits} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5 text-base">
                <StepNumber n={3} /> 生成客户汇报
              </CardTitle>
              <CardAction>
                {result && (
                  <div className="flex items-center gap-1">
                    {result.achievements.length > 2 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setExpandedCard(
                            expandedCard.size >= result.achievements.length
                              ? new Set()
                              : new Set(
                                  result.achievements.map((_, i) => i)
                                )
                          )
                        }
                      >
                        {expandedCard.size >= result.achievements.length
                          ? "全部收起"
                          : "全部展开"}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={analyze}
                      disabled={analyzing}
                    >
                      <RefreshCw className={cn(analyzing && "animate-spin")} />
                      重新分析
                    </Button>
                  </div>
                )}
              </CardAction>
            </CardHeader>

            {/* 页签：成果依据 / 客户汇报（核心输出） */}
            {result && (
              <div className="px-6 pb-1">
                <div className="flex gap-1 rounded-lg bg-muted/60 p-1">
                  <button
                    type="button"
                    onClick={() => setRightTab("achievements")}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      rightTab === "achievements"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    成果依据
                    <span className="ml-1.5 text-xs opacity-70">
                      {result.achievements.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightTab("report")}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      rightTab === "report"
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Send className="size-3.5" />
                    客户汇报
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightTab("estimate")}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      rightTab === "estimate"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Calculator className="size-3.5" />
                    估时报价
                  </button>
                </div>
              </div>
            )}

            <CardContent className="space-y-4">
              {analyzeError && <ErrorNote text={analyzeError} />}
              {result && !analyzing && (
                <AnalysisCoverage
                  commitCount={analyzedCommits.length}
                  evidence={result.evidence ?? []}
                  context={result.context}
                />
              )}
              {analyzeWarning && result && !analyzing && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{analyzeWarning}</span>
                </div>
              )}

              {result && rightTab === "estimate" && !analyzing && (
                <EstimatePanel
                  titles={result.achievements.map((a) => a.title)}
                  estimate={estimate}
                  hours={estimateHours}
                  onHoursChange={(i, h) =>
                    setEstimateHours((prev) => ({ ...prev, [i]: h }))
                  }
                  pricing={pricingDraft}
                  onPricingChange={updatePricing}
                  summary={quoteSummary}
                  loading={estimating}
                  error={estimateError}
                  onEstimate={runEstimate}
                />
              )}

              {/* 空状态 */}
              {!result && !analyzing && !analyzeError && (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
                  <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                    <Sparkles className="size-6" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    在左侧勾选提交，点击「分析选中的提交」，
                    <br />
                    这里会生成客户看得懂的成果卡片和进度汇报。
                  </p>
                </div>
              )}

              {/* 分析中骨架屏 */}
              {analyzing && (
                <div className="space-y-3">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    {analyzeProgress?.phase === "batch"
                      ? `${progressText.replace(/…$/, "")}：读取代码证据并翻译成客户成果…`
                      : analyzeProgress?.phase === "context" ||
                          analyzeProgress?.phase === "merge"
                        ? progressText
                        : "正在读取代码证据并翻译成客户成果…"}
                  </p>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex gap-3 rounded-xl border p-4">
                      <Skeleton className="size-9 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-2/5" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-4/5" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 成果卡：分类 + 影响力 + 可展开代码证据（仅「成果依据」页签） */}
              {result &&
                rightTab === "achievements" &&
                !analyzing &&
                result.achievements.map((a, i) => {
                  const cat = CATEGORY_META[a.category ?? "other"];
                  const imp = IMPACT_META[a.impact ?? "medium"];
                  const evidenced = a.status === "evidenced";
                  const expanded = expandedCard.has(i);
                  const hasEvidence = (a.evidence?.length ?? 0) > 0 || a.shas.length > 0;
                  return (
                    <div
                      key={`${a.title}-${i}`}
                      className="overflow-hidden rounded-xl border transition-shadow hover:shadow-sm"
                    >
                      <div className="flex items-start gap-3 p-4">
                        <div
                          className={cn(
                            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg text-white",
                            cat.dot
                          )}
                        >
                          <Layers className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={cn("font-medium", cat.chip)}
                            >
                              {cat.label}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn("font-medium", imp.chip)}
                            >
                              <TrendingUp className="size-3" />
                              {imp.label}
                            </Badge>
                            <Badge
                              className={cn(
                                "gap-1 font-medium",
                                evidenced
                                  ? "border-transparent bg-emerald-100 text-emerald-700"
                                  : "border-transparent bg-amber-100 text-amber-700"
                              )}
                            >
                              {evidenced ? <Check className="size-3" /> : <Clock className="size-3" />}
                              {evidenced ? "有依据" : "待验证"}
                            </Badge>
                          </div>
                          <div className="mt-1.5 text-sm font-semibold leading-snug">
                            {a.title}
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {a.description}
                          </p>
                          {a.value && a.value !== a.description && (
                            <p className="mt-1.5 rounded-lg bg-emerald-50/70 px-2.5 py-1.5 text-sm leading-relaxed text-emerald-800">
                              <span className="font-semibold">客户价值：</span>
                              {a.value}
                            </p>
                          )}
                          {a.note && (
                            <p className="mt-1.5 text-xs text-amber-600">
                              待验证：{a.note}
                            </p>
                          )}

                          {hasEvidence && (
                            <button
                              type="button"
                              onClick={() => toggleEvidence(i)}
                              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                            >
                              <ChevronRight
                                className={cn(
                                  "size-3.5 transition-transform",
                                  expanded && "rotate-90"
                                )}
                              />
                              {expanded ? "收起代码依据" : "查看代码依据"}
                              {a.shas.length > 0 && `（${a.shas.length} 个提交）`}
                            </button>
                          )}
                        </div>
                      </div>

                      {expanded && (
                        <div className="space-y-2 border-t bg-muted/30 px-4 py-3">
                          {a.evidence && a.evidence.length > 0 && (
                            <ul className="space-y-1">
                              {a.evidence.map((e, k) => (
                                <li
                                  key={k}
                                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                                >
                                  <Check className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                                  <span>{e}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {a.shas.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1 pt-0.5">
                              <GitCommitHorizontal className="size-3 text-muted-foreground" />
                              {a.shas.map((sha) => (
                                <Badge
                                  key={sha}
                                  variant="secondary"
                                  className="font-mono text-[11px] font-normal"
                                >
                                  {sha}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

              {/* 客户版汇报：核心输出，置顶呈现（仅「客户汇报」页签） */}
              {result && rightTab === "report" && !analyzing && (
                <div className="space-y-3">
                  {/* 顶部操作条 */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <FileText className="size-4 text-primary" />
                      客户版汇报
                      <Badge variant="secondary" className="font-normal">
                        {plainReport.length} 字
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingReport((v) => !v)}
                      >
                        {editingReport ? <Check /> : <Wrench />}
                        {editingReport ? "完成编辑" : "编辑"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          downloadFile(
                            reportToWordHtml(result.report, {
                              repo: repo?.fullName,
                              stats: result.stats,
                              quote: exportQuote,
                              details: exportDetails,
                            }),
                            `${repo?.fullName ?? "阶段工作汇报"}-成果汇报.doc`,
                            "application/msword;charset=utf-8"
                          )
                        }
                        title="导出为 Word 文档（.doc）"
                      >
                        <Download />
                        Word
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          copyText(
                            reportToMarkdown(result.report, {
                              repo: repo?.fullName,
                              quote: exportQuote,
                              details: exportDetails,
                            }),
                            "md"
                          )
                        }
                      >
                        {copied === "md" ? <Check /> : <Copy />}
                        Markdown
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          copyText(
                            reportOverride ?? plainReport,
                            "text"
                          )
                        }
                      >
                        {copied === "text" ? <Check /> : <Send />}
                        {copied === "text" ? "已复制" : "复制发客户"}
                      </Button>
                    </div>
                  </div>

                  {/* 可编辑模式 */}
                  {editingReport ? (
                    <Textarea
                      id="client-report"
                      value={reportOverride ?? plainReport}
                      onChange={(e) => setReportOverride(e.target.value)}
                      placeholder="可直接修改汇报内容，改动仅影响复制/导出的文本。"
                      className="min-h-64 text-sm leading-relaxed"
                    />
                  ) : (
                    /* 文档式预览 */
                    <article className="overflow-hidden rounded-xl border bg-background shadow-sm">
                      <div className="border-b bg-gradient-to-r from-emerald-50 to-transparent px-5 py-4">
                        <h3 className="text-base font-bold tracking-tight">
                          {repo?.fullName ?? "阶段工作汇报"}
                        </h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          工作成果汇报 · 覆盖 {localStats.days} 天 ·{" "}
                          {localStats.commitCount} 次提交 ·{" "}
                          {localStats.contributorCount} 位成员参与
                        </p>
                      </div>

                      <div className="space-y-4 px-5 py-4">
                        {result.report.summary && (
                          <p className="text-sm leading-relaxed">
                            {result.report.summary}
                          </p>
                        )}

                        <ol className="space-y-3">
                          {result.report.items.map((it, i) => (
                            <li
                              key={i}
                              className="flex gap-3 border-l-2 border-primary/20 pl-3"
                            >
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                                {i + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-semibold">
                                    {it.title}
                                  </span>
                                  {it.status === "unverified" && (
                                    <Badge
                                      variant="outline"
                                      className="border-amber-200 bg-amber-50 text-[11px] font-normal text-amber-700"
                                    >
                                      上线后验证
                                    </Badge>
                                  )}
                                </div>
                                {it.detail && (
                                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                                    {it.detail}
                                  </p>
                                )}
                              </div>
                            </li>
                          ))}
                        </ol>

                        {exportDetails && exportDetails.categories.length > 0 && (
                          <div className="space-y-2 border-t pt-3">
                            <p className="text-sm font-semibold">工作明细</p>
                            {exportDetails.categories.map((g) => (
                              <div key={g.category} className="space-y-1">
                                <Badge
                                  variant="outline"
                                  className={cn("font-normal", CATEGORY_META[g.category].chip)}
                                >
                                  {CATEGORY_META[g.category].label} · {g.items.length}
                                </Badge>
                                <ul className="space-y-1 pl-1">
                                  {g.items.map((it, k) => (
                                    <li key={k} className="text-sm leading-relaxed">
                                      <span className="font-medium">{it.title}</span>
                                      <span className="text-muted-foreground">
                                        ：{it.description}
                                      </span>
                                      <span className="ml-1 text-xs text-muted-foreground">
                                        （{it.commitCount} 个提交）
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}

                        {exportDetails && exportDetails.timeline.length > 0 && (
                          <div className="space-y-1.5 border-t pt-3">
                            <p className="text-sm font-semibold">按周进展</p>
                            <table className="w-full text-sm">
                              <tbody>
                                {exportDetails.timeline.map((w) => (
                                  <tr key={w.start} className="border-b align-top last:border-0">
                                    <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                                      {w.start === w.end
                                        ? shortDay(w.start)
                                        : `${shortDay(w.start)} - ${shortDay(w.end)}`}
                                    </td>
                                    <td className="whitespace-nowrap py-1.5 pr-3 text-right">
                                      {w.commitCount} 次提交
                                    </td>
                                    <td className="py-1.5 text-muted-foreground">
                                      {w.completed.join("、") || "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {exportDetails?.heatmap && exportDetails.heatmap.total > 0 && (
                          <div className="space-y-1.5 border-t pt-3">
                            <p className="text-sm font-semibold">提交活跃度</p>
                            <CommitHeatmap data={exportDetails.heatmap} />
                          </div>
                        )}

                        {(result.report.risks?.length ?? 0) > 0 && (
                          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-sm leading-relaxed">
                            <p className="font-semibold text-amber-800">风险与待跟进</p>
                            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-amber-900/80">
                              {result.report.risks!.map((r, k) => (
                                <li key={k}>{r}</li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {result.report.nextSteps && (
                          <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm leading-relaxed">
                            <span className="font-semibold">后续计划：</span>
                            <span className="text-muted-foreground">
                              {result.report.nextSteps}
                            </span>
                          </div>
                        )}

                        {exportQuote && (
                          <div className="space-y-1.5 border-t pt-3">
                            <p className="text-sm font-semibold">工作量与报价</p>
                            <table className="w-full text-sm">
                              <tbody>
                                {exportQuote.lines.map((l, i) => (
                                  <Fragment key={i}>
                                    <tr className="border-b last:border-0">
                                      <td className="py-1.5 pr-2">{l.title}</td>
                                      <td className="whitespace-nowrap py-1.5 pr-2 text-right text-muted-foreground">
                                        {l.quantity.toLocaleString("zh-CN", {
                                          maximumFractionDigits: 2,
                                        })}{" "}
                                        {exportQuote.unitLabel}
                                      </td>
                                      <td className="whitespace-nowrap py-1.5 text-right">
                                        {formatMoney(l.amount, exportQuote.currency)}
                                      </td>
                                    </tr>
                                    {(l.tasks ?? []).map((t, k) => (
                                      <tr key={k} className="border-b text-xs text-muted-foreground">
                                        <td className="py-1 pl-4 pr-2">{t.name}</td>
                                        <td className="whitespace-nowrap py-1 pr-2 text-right">
                                          {t.quantity.toLocaleString("zh-CN", {
                                            maximumFractionDigits: 2,
                                          })}{" "}
                                          {exportQuote.unitLabel}
                                        </td>
                                        <td />
                                      </tr>
                                    ))}
                                  </Fragment>
                                ))}
                                <tr className="font-semibold">
                                  <td className="pt-1.5">合计</td>
                                  <td className="whitespace-nowrap pt-1.5 pr-2 text-right">
                                    {exportQuote.totalQuantity.toLocaleString("zh-CN", {
                                      maximumFractionDigits: 2,
                                    })}{" "}
                                    {exportQuote.unitLabel}
                                  </td>
                                  <td className="whitespace-nowrap pt-1.5 text-right text-primary">
                                    {formatMoney(exportQuote.totalAmount, exportQuote.currency)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </article>
                  )}

                  <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox
                      checked={includeDetails}
                      onCheckedChange={(v) => setIncludeDetails(v === true)}
                    />
                    附带工作明细、按周进展与活跃度图
                  </label>

                  {/* 附带报价开关：成本与利润率永不导出 */}
                  <label
                    className={cn(
                      "flex items-center gap-2 text-sm",
                      quoteSummary
                        ? "cursor-pointer text-muted-foreground"
                        : "cursor-not-allowed text-muted-foreground/60"
                    )}
                  >
                    <Checkbox
                      checked={includeQuote && !!quoteSummary}
                      disabled={!quoteSummary}
                      onCheckedChange={(v) => setIncludeQuote(v === true)}
                    />
                    附带工作量与报价
                    {!quoteSummary && (
                      <button
                        type="button"
                        className="text-xs text-primary underline underline-offset-2"
                        onClick={() => setRightTab("estimate")}
                      >
                        先去估算
                      </button>
                    )}
                  </label>
                  {includeQuote && reportOverride !== null && (
                    <p className="text-xs text-amber-600">
                      你已手动编辑过汇报文本，「复制发客户」会使用编辑后的内容，报价需自行补充；Word 与 Markdown 导出不受影响。
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          </div>
        </div>

        <SiteFooter />
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={aiSettings}
        onSave={(s) => {
          setAiSettings(s);
          persistSettings(s);
          // 用户刚补上 PAT / 自定义 API 地址时，若此前仓库没加载出来，
          // 自动用新设置重试一次，避免用户还要重新输入仓库地址。
          if (!repo && repoInput.trim()) {
            void loadRepo(repoInput.trim());
          }
        }}
      />
    </div>
  );
}
