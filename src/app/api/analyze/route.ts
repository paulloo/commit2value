import { NextResponse } from "next/server";
import { resolveGhBase } from "@/lib/github";
import { enrichWithEvidenceSafe } from "@/lib/evidence";
import {
  AI_NOT_CONFIGURED_MESSAGE,
  chatJson,
  makeShaResolver,
  resolveAiConfig,
} from "@/lib/ai";
import { ANALYZE_BATCH_SIZE, MAX_BATCH_ACHIEVEMENTS } from "@/lib/limits";
import {
  MAX_REPORT_RISKS,
  normalizeAchievement,
  normalizeReport,
} from "@/lib/achievements";
import { MAX_CONTEXT_CHARS } from "@/lib/project-docs";
import {
  gitlabCommitEvidence,
  resolveGitLabBase,
} from "@/lib/gitlab";
import type { Achievement, CommitEvidence } from "@/lib/types";

const PROMPT_RULES = `你是一名资深技术项目经理兼技术布道者，核心能力是把程序员的 Git 提交翻译成客户能听懂、愿意买单的工作成果。

你收到的每条提交都带有客观代码证据：作者、改动文件数、增删行数、涉及的文件路径、关联的 PR，以及改动摘录（diff 中的增删行与 hunk 头，已省略上下文和缩进）。这些是事实依据。
输入开头可能附有项目背景（摘自仓库 README 等文档），它描述的是项目整体而非本期工作，只用于理解业务术语和模块职责。

【铁律】
1. 只依据给定的提交与代码证据归纳。严禁编造不存在的功能、指标、百分比或性能提升数字；严禁把项目背景中描述、但本批提交没有改动的功能写成成果。
2. 有改动摘录时，以实际改动判断做了什么；提交标题与改动不符时以改动为准。
3. 没有证据支撑的量化收益一律不写。若要提及影响，只能定性描述（如"减少重复请求""提升可维护性"）。
4. shas 只能取自给定列表中的短哈希，禁止编造。
5. 禁止使用"赋能""抓手""闭环"这类空洞的营销词；要用具体的动作和对象来描述。

【成果归类 category 必选其一】
feature(新功能/功能交付)、performance(性能优化)、experience(交互与体验改进)、
stability(稳定性与缺陷修复)、efficiency(工程效率与重构)、security(安全与合规)、other(其他)

【影响程度 impact】
high(客户可直接感知或业务关键)、medium(明显改善)、low(内部优化或小修)

【字段要求】
- title：8-18 字，具体动作 + 对象，不要用"优化了""改进了"这种空话。
- description：1-2 句，说明做了什么、怎么做的（可引用文件/模块名增强可信度）。
- value：1 句写清对客户/业务的意义，这是给客户看的核心，不要与 description 重复。
- status：已在代码中完成且可验证 → "evidenced"；效果需上线后才能度量（性能、稳定性、长期收益）→ "unverified"，并在 note 用 15 字内说明验证方式。
- evidence：2-4 条客观证据，直接摘录代码事实（如"新增 6 个文件"、"改动 src/api 12 个文件 +340/-58"、"关联 PR #123"），禁止主观评价。`;

const SYSTEM_PROMPT = `${PROMPT_RULES}

【报告 report】
- summary：一句话总览，说明这段时间整体交付了什么。
- items：与成果卡一一对应，detail 用 value 的文案。
- nextSteps：1-2 句说明后续如何跟进上线效果与下一步计划。
- risks：0-${MAX_REPORT_RISKS} 条风险与待跟进事项，每条一句、不超过 40 字。只写代码证据或提交信息中能直接看出的问题，例如标注为临时方案或待完善的改动、只完成一部分的迁移、改动核心逻辑却没有相应测试、为兼容保留的旧代码。没有明确依据时输出空数组，严禁凭空推测。
- 全文使用中文，不使用 Markdown 符号（#、*、- 等），控制在 400 字内。

严格输出如下 JSON 对象，不要输出任何其他文本：
{"achievements":[{"title":"","description":"","value":"","shas":["a13c72f"],"status":"evidenced","note":"","category":"feature","impact":"high","evidence":[""]}],"report":{"summary":"","items":[{"title":"","detail":"","status":"evidenced"}],"nextSteps":"","risks":[""]}}`;

/**
 * 分批模式：本批只是全部提交的一部分，报告由 /api/analyze/merge 统一撰写，
 * 这里不输出 report 以节省输出 token（单批耗时主要由输出长度决定）。
 */
const BATCH_SYSTEM_PROMPT = `${PROMPT_RULES}

【分批说明】
本次输入只是全部提交中的一批，后续会与其他批次合并。只输出 achievements，不要输出 report。
同一功能的多次提交应归为一条成果；成果总数不超过 ${MAX_BATCH_ACHIEVEMENTS} 条。

严格输出如下 JSON 对象，不要输出任何其他文本：
{"achievements":[{"title":"","description":"","value":"","shas":["a13c72f"],"status":"evidenced","note":"","category":"feature","impact":"high","evidence":[""]}]}`;

type CommitInput = {
  sha: string;
  shortSha: string;
  title: string;
  description?: string;
  date?: string;
  author?: string;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      repo,
      owner,
      name,
      branch,
      branches,
      commits,
      mode,
      projectContext,
      settings,
    }: {
      repo?: string;
      owner?: string;
      name?: string;
      /** 兼容旧调用：单分支 */
      branch?: string;
      branches?: string[];
      commits?: CommitInput[];
      /** batch = 分批分析中的一批（不生成报告）；缺省为完整分析 */
      mode?: "batch";
      /** 项目背景文本（由 /api/project-context 生成，前端在各批次间复用） */
      projectContext?: string;
      settings?: {
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        ghBaseUrl?: string;
        ghToken?: string;
        glBaseUrl?: string;
        glToken?: string;
        provider?: "github" | "gitlab";
      };
    } = body;

    if (!Array.isArray(commits) || commits.length === 0) {
      return NextResponse.json(
        { error: "请先在左侧选择至少一条提交" },
        { status: 400 }
      );
    }

    // 超出单批上限直接拒绝，而不是静默截断：否则界面上勾选了的提交并未参与分析。
    // 更多提交由前端拆批后逐批请求（见 src/lib/analyze-client.ts）
    const isBatch = mode === "batch";
    if (commits.length > ANALYZE_BATCH_SIZE) {
      return NextResponse.json(
        {
          error: `单次请求最多分析 ${ANALYZE_BATCH_SIZE} 个提交，当前 ${commits.length} 个，请缩小范围后重试。`,
          code: "TOO_MANY_COMMITS",
        },
        { status: 400 }
      );
    }

    const branchList = (
      Array.isArray(branches) && branches.length ? branches : branch ? [branch] : []
    ).map(String);

    const aiCfg = resolveAiConfig(settings);
    if (!aiCfg.apiKey) {
      return NextResponse.json(
        { error: AI_NOT_CONFIGURED_MESSAGE, code: "AI_NOT_CONFIGURED" },
        { status: 400 }
      );
    }

    // ---- 拉取真实代码证据（失败则降级为仅用提交信息，不阻断流程）----
    const provider = settings?.provider ?? "github";
    let evidenceMap = new Map<string, CommitEvidence>();

    if (provider === "gitlab" && owner && name) {
      // GitLab：逐条拉取 diff 文件列表（并发受控）
      const glBase = resolveGitLabBase(settings?.glBaseUrl);
      const projectId = `${owner}/${name}`;
      const targets = commits.slice(0, ANALYZE_BATCH_SIZE);
      let cursor = 0;
      const CONCURRENCY = 5;
      async function glWorker() {
        while (cursor < targets.length) {
          const c = targets[cursor++];
          try {
            const ev = await gitlabCommitEvidence(
              glBase,
              projectId,
              c.sha,
              settings?.glToken
            );
            if (!ev) continue;
            evidenceMap.set(c.sha, {
              sha: c.sha,
              additions: 0,
              deletions: 0,
              changedFiles: ev.changedFiles,
              filePaths: ev.filePaths,
              prNumbers: [],
              diffExcerpt: ev.diffExcerpt,
            });
          } catch {
            // 单个失败不影响整体
          }
        }
      }
      // 同样加硬超时兜底，避免 GitLab 分支无限等待
      await Promise.race([
        Promise.all(
          Array.from(
            { length: Math.min(CONCURRENCY, targets.length) },
            () => glWorker()
          )
        ),
        new Promise((r) => setTimeout(r, 6500)),
      ]);
    } else if (owner && name) {
      try {
        evidenceMap = await enrichWithEvidenceSafe(
          resolveGhBase(settings?.ghBaseUrl),
          owner,
          name,
          commits,
          settings?.ghToken
        );
      } catch (e) {
        console.error("[analyze] evidence fetch failed, degrade:", e);
      }
    }

    // ---- 组装带证据的提交清单 ----
    // 送入模型的提交数已由上方 ANALYZE_BATCH_SIZE 校验约束
    const resolveSha = makeShaResolver(commits.map((c) => c.shortSha));
    const commitLines = commits
      .map((c, i) => {
        const date = c.date ? new Date(c.date).toISOString().slice(0, 10) : "";
        const ev = evidenceMap.get(c.sha);
        const evLines: string[] = [];
        if (ev) {
          evLines.push(
            `   代码证据：${ev.changedFiles} 个文件，+${ev.additions}/-${ev.deletions} 行`
          );
          if (ev.filePaths.length) {
            evLines.push(
              `   主要文件：${ev.filePaths.slice(0, 4).join(", ")}`
            );
          }
          if (ev.prNumbers.length) {
            evLines.push(`   关联 PR：#${ev.prNumbers.join(" #")}`);
          }
          if (ev.diffExcerpt) {
            evLines.push(
              `   改动摘录：\n${ev.diffExcerpt
                .split("\n")
                .map((l) => "     " + l)
                .join("\n")}`
            );
          }
        }
        return `${i + 1}. [${c.shortSha}] ${date} 作者：${c.author ?? "未知"}\n   标题：${c.title}${
          c.description ? `\n   详情：${c.description.slice(0, 120)}` : ""
        }${evLines.length ? "\n" + evLines.join("\n") : "\n   代码证据：未获取到"}`;
      })
      .join("\n");

    const branchLabel = branchList.length ? branchList.join("、") : "未知";
    const contextText =
      typeof projectContext === "string" ? projectContext.slice(0, MAX_CONTEXT_CHARS) : "";
    const contextBlock = contextText
      ? `项目背景（摘自仓库文档，仅用于理解业务术语，不是本期成果）：\n${contextText}\n\n`
      : "";
    const ai = await chatJson(
      aiCfg,
      isBatch ? BATCH_SYSTEM_PROMPT : SYSTEM_PROMPT,
      `${contextBlock}仓库：${repo ?? "未知"}\n分支：${branchLabel}\n提交数量：${commits.length}\n\n提交与代码证据：\n${commitLines}`,
      { timeoutMs: 75000 }
    );
    if (!ai.ok) {
      return NextResponse.json(
        { error: ai.error, code: ai.code },
        { status: ai.status }
      );
    }
    const parsed = (ai.data ?? {}) as { achievements?: unknown; report?: unknown };

    const achievements: Achievement[] = (
      Array.isArray(parsed.achievements) ? parsed.achievements : []
    )
      .map((a) => normalizeAchievement(a, resolveSha))
      .filter((a): a is Achievement => !!a)
      .slice(0, MAX_BATCH_ACHIEVEMENTS);

    if (achievements.length === 0) {
      return NextResponse.json(
        { error: "AI 未能归纳出有效成果，请重试一次" },
        { status: 502 }
      );
    }

    // ---- 结构化报告（分批模式由合并接口统一生成）----
    const report = isBatch ? undefined : normalizeReport(parsed.report, achievements);

    // ---- 统计数据（由前端已有提交数据计算，服务端仅补 PR 数）----
    let prCount = 0;
    for (const ev of evidenceMap.values()) prCount += ev.prNumbers.length;

    return NextResponse.json({
      achievements,
      report,
      stats: {
        commitCount: commits.length,
        additions: [...evidenceMap.values()].reduce((s, e) => s + e.additions, 0),
        deletions: [...evidenceMap.values()].reduce((s, e) => s + e.deletions, 0),
        changedFiles: [...evidenceMap.values()].reduce(
          (s, e) => s + e.changedFiles,
          0
        ),
        contributorCount: new Set(commits.map((c) => c.author).filter(Boolean)).size,
        prCount,
      },
      evidence: [...evidenceMap.values()],
    });
  } catch (e) {
    console.error("[analyze] exception:", e);
    return NextResponse.json(
      { error: "分析请求失败，请稍后重试" },
      { status: 500 }
    );
  }
}