import {
  ANALYZE_BATCH_CONCURRENCY,
  ANALYZE_BATCH_SIZE,
} from "@/lib/limits";
import { reportFromAchievements } from "@/lib/achievements";
import type {
  Achievement,
  AnalyzeResult,
  AnalyzeStats,
  CommitEvidence,
  CommitItem,
  ProjectContext,
  ReportContent,
} from "@/lib/types";

/**
 * 前端分析编排。
 *
 * 不超过 ANALYZE_BATCH_SIZE 条：一次 /api/analyze 直接出成果与报告。
 * 超过时：拆成均衡的若干批（并发 ANALYZE_BATCH_CONCURRENCY）逐批请求，
 * 每批失败自动重试一次，仍失败则整体失败（不出不完整的报告）；
 * 全部成功后调用 /api/analyze/merge 去重合并并撰写总报告。
 *
 * 编排放在前端而不是服务端循环：每个请求都要各自落在网关超时之内。
 */

export type AnalyzeProgress =
  | { phase: "context" }
  | { phase: "analyze" }
  | { phase: "batch"; done: number; total: number }
  | { phase: "merge" };

export interface AnalyzeRequest {
  repo: string;
  owner: string;
  name: string;
  branches: string[];
  commits: CommitItem[];
  settings: object;
}

export type AnalyzeOutcome =
  | { ok: true; result: AnalyzeResult; warning?: string }
  | { ok: false; error: string; code?: string; aborted?: boolean };

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
  /** 服务端/网络类错误可重试；配置错误（4xx）与输出截断重试无意义 */
  get retryable() {
    return (this.status >= 500 || this.status === 0) && this.code !== "TRUNCATED";
  }
}

function isAbort(e: unknown) {
  return (e as { name?: string } | null)?.name === "AbortError";
}

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new RequestError("网络错误，请稍后重试", 0);
  }
  let data: { error?: string; code?: string } = {};
  try {
    data = await res.json();
  } catch {
    // 网关超时等场景返回的是 HTML，按状态码处理
  }
  if (!res.ok) {
    throw new RequestError(
      data.error || `请求失败（${res.status}）`,
      res.status,
      data.code
    );
  }
  return data as T;
}

/** 截断后自动拆分的最小批次：再小仍被截断说明问题不在输入规模（如思考模式占满输出） */
const MIN_SPLIT_SIZE = 4;

/** 均衡拆批：120 条拆成 40/40/40，而不是 50/50/20，让每批耗时接近 */
export function splitBatches<T>(items: T[], maxSize = ANALYZE_BATCH_SIZE): T[][] {
  const count = Math.ceil(items.length / maxSize);
  const size = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, i) => items.slice(i * size, (i + 1) * size));
}

type BatchResponse = {
  achievements: Achievement[];
  evidence?: CommitEvidence[];
};

type MergeResponse = {
  achievements: Achievement[];
  report: ReportContent;
  warning?: string;
};

function aggregateStats(commits: CommitItem[], evidence: CommitEvidence[]): AnalyzeStats {
  const authors = new Map<string, number>();
  for (const c of commits) {
    const k = c.author || "未知";
    authors.set(k, (authors.get(k) ?? 0) + 1);
  }
  return {
    commitCount: commits.length,
    additions: evidence.reduce((s, e) => s + e.additions, 0),
    deletions: evidence.reduce((s, e) => s + e.deletions, 0),
    changedFiles: evidence.reduce((s, e) => s + e.changedFiles, 0),
    contributorCount: authors.size,
    prCount: evidence.reduce((s, e) => s + e.prNumbers.length, 0),
    topContributors: [...authors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({ name, count })),
  };
}

export async function runAnalyze(
  req: AnalyzeRequest,
  opts: { signal: AbortSignal; onProgress?: (p: AnalyzeProgress) => void }
): Promise<AnalyzeOutcome> {
  const { commits, settings, ...meta } = req;
  const fail = (e: unknown): AnalyzeOutcome =>
    isAbort(e)
      ? { ok: false, error: "已取消分析", aborted: true }
      : e instanceof RequestError
        ? { ok: false, error: e.message, code: e.code }
        : { ok: false, error: "分析失败，请稍后重试" };

  // ---- 项目背景：只读一次，复用到所有批次与合并；失败按空背景继续 ----
  opts.onProgress?.({ phase: "context" });
  let context: ProjectContext = { text: "", sources: [] };
  try {
    context = await postJson<ProjectContext>(
      "/api/project-context",
      { owner: meta.owner, name: meta.name, ref: meta.branches[0], settings },
      opts.signal
    );
  } catch (e) {
    if (isAbort(e)) return fail(e);
  }
  const projectContext = context.text || undefined;

  // ---- 单批：保持原有的一次调用；输出被截断时改走拆批流程 ----
  let batches = splitBatches(commits);
  if (commits.length <= ANALYZE_BATCH_SIZE) {
    opts.onProgress?.({ phase: "analyze" });
    try {
      const result = await postJson<AnalyzeResult>(
        "/api/analyze",
        { ...meta, commits, settings, projectContext },
        opts.signal
      );
      return { ok: true, result: { ...result, context } };
    } catch (e) {
      if (!(e instanceof RequestError && e.code === "TRUNCATED" && commits.length > MIN_SPLIT_SIZE)) {
        return fail(e);
      }
      batches = splitBatches(commits, Math.ceil(commits.length / 2));
    }
  }

  // ---- 多批：并发拉取，任一批最终失败即取消其余批次 ----
  const results: BatchResponse[] = new Array(batches.length);
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  opts.signal.addEventListener("abort", onOuterAbort);

  let cursor = 0;
  let done = 0;
  let failure: unknown = null;
  opts.onProgress?.({ phase: "batch", done: 0, total: batches.length });

  async function postBatch(chunk: CommitItem[]): Promise<BatchResponse> {
    const body = { ...meta, commits: chunk, settings, mode: "batch", projectContext };
    try {
      return await postJson<BatchResponse>("/api/analyze", body, inner.signal);
    } catch (e) {
      if (e instanceof RequestError && e.retryable && !inner.signal.aborted) {
        return await postJson<BatchResponse>("/api/analyze", body, inner.signal);
      }
      throw e;
    }
  }

  /**
   * 输出被截断时对半拆分后分别重新分析（同样输入重试无意义，减小输入才能缩短输出），
   * 拆到 MIN_SPLIT_SIZE 条仍被截断才报错。两半顺序执行，不额外占用并发。
   */
  async function analyzeChunk(chunk: CommitItem[]): Promise<BatchResponse> {
    try {
      return await postBatch(chunk);
    } catch (e) {
      if (!(e instanceof RequestError && e.code === "TRUNCATED")) throw e;
      if (chunk.length <= MIN_SPLIT_SIZE) {
        throw new RequestError(
          `已自动拆分到 ${chunk.length} 个提交仍被截断。${e.message}`,
          e.status,
          e.code
        );
      }
      const mid = Math.ceil(chunk.length / 2);
      const a = await analyzeChunk(chunk.slice(0, mid));
      const b = await analyzeChunk(chunk.slice(mid));
      return {
        achievements: [...(a.achievements ?? []), ...(b.achievements ?? [])],
        evidence: [...(a.evidence ?? []), ...(b.evidence ?? [])],
      };
    }
  }

  async function worker() {
    while (cursor < batches.length && !failure) {
      const i = cursor++;
      try {
        results[i] = await analyzeChunk(batches[i]);
        done++;
        opts.onProgress?.({ phase: "batch", done, total: batches.length });
      } catch (e) {
        if (!failure) {
          failure =
            e instanceof RequestError
              ? new RequestError(
                  // 可重试的错误抛到这里说明重试也失败了；不可重试的（截断、配置错误）未重试
                  `第 ${i + 1}/${batches.length} 批分析失败${e.retryable ? "（已重试）" : ""}：${e.message}`,
                  e.status,
                  e.code
                )
              : e;
        }
        inner.abort();
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(ANALYZE_BATCH_CONCURRENCY, batches.length) }, worker)
    );
  } finally {
    opts.signal.removeEventListener("abort", onOuterAbort);
  }
  if (opts.signal.aborted) return fail(Object.assign(new Error(), { name: "AbortError" }));
  if (failure) return fail(failure);

  const allAchievements = results.flatMap((r) => r.achievements ?? []);
  const evidenceBySha = new Map<string, CommitEvidence>();
  for (const r of results) for (const ev of r.evidence ?? []) evidenceBySha.set(ev.sha, ev);
  const evidence = [...evidenceBySha.values()];
  const stats = aggregateStats(commits, evidence);

  // ---- 合并：接口内部已对 AI 失败做降级；这里再兜底网络层失败 ----
  opts.onProgress?.({ phase: "merge" });
  let merged: MergeResponse;
  try {
    merged = await postJson<MergeResponse>(
      "/api/analyze/merge",
      {
        repo: meta.repo,
        branches: meta.branches,
        commitCount: commits.length,
        achievements: allAchievements,
        projectContext,
        settings,
      },
      opts.signal
    );
  } catch (e) {
    if (isAbort(e)) return fail(e);
    merged = {
      achievements: allAchievements,
      report: reportFromAchievements(allAchievements),
      warning: `成果合并失败（${(e as Error).message}），已按批次直接拼接，可能存在重复成果。`,
    };
  }

  return {
    ok: true,
    result: {
      achievements: merged.achievements,
      report: merged.report,
      stats,
      evidence,
      context,
    },
    warning: merged.warning,
  };
}
