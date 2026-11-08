import { NextResponse } from "next/server";
import {
  AI_NOT_CONFIGURED_MESSAGE,
  chatJson,
  makeShaResolver,
  resolveAiConfig,
} from "@/lib/ai";
import { MAX_ESTIMATE_ACHIEVEMENTS as MAX_ACHIEVEMENTS } from "@/lib/limits";
import { MAX_CONTEXT_CHARS } from "@/lib/project-docs";
import type { CommitEvidence, EstimateItem, EstimateTask } from "@/lib/types";

const SYSTEM_PROMPT = `你是一名资深技术项目经理，负责评估已完成开发工作的实际投入工时，用于内部成本核算与对外报价。

你会收到若干条已归纳好的工作成果，每条都附有关联提交和客观代码证据（改动文件数、增删行数、主要文件路径），多数还附有改动摘录（diff 中的增删行与 hunk 头）。输入开头可能附有项目背景（摘自仓库文档），用于理解业务与技术栈。

【估算口径】
1. 以一名熟悉该项目的中级工程师为基准，估算完成该成果所需的工时（小时），包含方案设计、编码、自测与联调，不含需求沟通与等待时间。
2. 给出区间：hoursLow 为顺利情况，hoursHigh 为考虑排查与返工的情况。hoursLow 不小于 0.5，hoursHigh 不小于 hoursLow，单条不超过 400。
3. 有改动摘录时，以实际改动内容判断复杂度（涉及的模块数、是否改动数据结构/接口/并发与事务逻辑、是否只是文案或配置），并在 basis 中引用。增删行数只是参考：lock 文件、自动生成代码、批量重命名、格式化带来的行数不代表工作量；缺陷排查、性能调优、架构调整往往改动少但耗时多。
4. 没有代码证据时，依据提交标题与成果描述做保守估计，并在 basis 中注明"证据不足"。
5. 只输出工时，严禁输出任何金额、费率或价格。

【任务拆分 tasks】
6. 把每条成果的工作拆成 2-4 个子任务，按实际改动内容命名（如"订单接口开发""列表页改造""迁移脚本""联调自测"），不要套用与改动无关的通用阶段。
7. 子任务名称不超过 10 字；hours 为该子任务的工时，各子任务合计应落在 hoursLow 与 hoursHigh 之间。
8. 改动很小（合计不超过 2 小时）的成果可以只拆 1 个子任务。

【字段要求】
- index：与输入成果编号一致。
- basis：1 句话，说明估算依据（引用改动规模或复杂度），不超过 50 字。
- assumptions：1-2 句话，说明整体估算前提。
- 全文使用中文。

严格输出如下 JSON 对象，不要输出任何其他文本：
{"items":[{"index":1,"hoursLow":2,"hoursHigh":4,"basis":"","tasks":[{"name":"","hours":1.5},{"name":"","hours":1.5}]}],"assumptions":""}`;

const MAX_HOURS = 400;
const MAX_TASKS = 4;

/**
 * 子任务归一化：丢弃无名或非正工时项；合计超出 [low, high] 时按比例缩放到区间中点，
 * 让拆分与总工时自洽（总工时以 hoursLow/hoursHigh 为准，子任务只是它的分解）。
 */
function normalizeTasks(raw: unknown, low: number, high: number): EstimateTask[] {
  if (!Array.isArray(raw) || high <= 0) return [];
  const tasks = raw
    .slice(0, MAX_TASKS)
    .map((t) => {
      const x = (t ?? {}) as { name?: unknown; hours?: unknown };
      const hours = Number(x.hours);
      return {
        name: typeof x.name === "string" ? x.name.trim().slice(0, 16) : "",
        hours: Number.isFinite(hours) ? Math.min(Math.max(hours, 0), MAX_HOURS) : 0,
      };
    })
    .filter((t) => t.name && t.hours > 0);
  const sum = tasks.reduce((s, t) => s + t.hours, 0);
  if (!tasks.length || (sum >= low && sum <= high)) return tasks;
  const factor = (low + high) / 2 / sum;
  return tasks.map((t) => ({ ...t, hours: Math.round(t.hours * factor * 10) / 10 }));
}

type AchievementInput = {
  title: string;
  description?: string;
  category?: string;
  shas?: string[];
};

type CommitInput = { sha?: string; shortSha: string; title: string };

export async function POST(req: Request) {
  try {
    const {
      repo,
      achievements,
      commits,
      evidence,
      projectContext,
      settings,
    }: {
      repo?: string;
      achievements?: AchievementInput[];
      commits?: CommitInput[];
      evidence?: CommitEvidence[];
      projectContext?: string;
      settings?: { baseUrl?: string; apiKey?: string; model?: string };
    } = await req.json();

    if (!Array.isArray(achievements) || achievements.length === 0) {
      return NextResponse.json(
        { error: "没有可估算的成果，请先生成成果" },
        { status: 400 }
      );
    }
    if (achievements.length > MAX_ACHIEVEMENTS) {
      return NextResponse.json(
        { error: `单次最多估算 ${MAX_ACHIEVEMENTS} 条成果` },
        { status: 400 }
      );
    }

    const aiCfg = resolveAiConfig(settings);
    if (!aiCfg.apiKey) {
      return NextResponse.json(
        { error: AI_NOT_CONFIGURED_MESSAGE, code: "AI_NOT_CONFIGURED" },
        { status: 400 }
      );
    }

    // ---- 短哈希 → 提交 / 证据 ----
    const commitList = Array.isArray(commits) ? commits : [];
    const resolveSha = makeShaResolver(commitList.map((c) => c.shortSha));
    const commitByShort = new Map(commitList.map((c) => [c.shortSha, c]));
    const evidenceByShort = new Map<string, CommitEvidence>();
    for (const ev of Array.isArray(evidence) ? evidence : []) {
      const short = resolveSha(ev?.sha);
      if (short) evidenceByShort.set(short, ev);
    }

    // 摘录总量控制在约 4 万字内：成果越多，每条分到的篇幅越少
    const excerptBudget = Math.max(
      300,
      Math.min(2000, Math.floor(40000 / achievements.length))
    );
    const blocks = achievements.map((a, i) => {
      const shas = (Array.isArray(a.shas) ? a.shas : [])
        .map(resolveSha)
        .filter((s): s is string => !!s);
      const evs = shas
        .map((s) => evidenceByShort.get(s))
        .filter((e): e is CommitEvidence => !!e);

      const lines = [
        `${i + 1}. ${String(a.title ?? "").slice(0, 60)}（${a.category ?? "other"}）`,
        `   描述：${String(a.description ?? "").slice(0, 200)}`,
      ];
      if (shas.length) {
        lines.push(
          `   关联提交：${shas
            .map((s) => `[${s}] ${commitByShort.get(s)?.title ?? ""}`.trim())
            .join("；")
            .slice(0, 400)}`
        );
      }
      if (evs.length) {
        const files = evs.reduce((s, e) => s + (Number(e.changedFiles) || 0), 0);
        const add = evs.reduce((s, e) => s + (Number(e.additions) || 0), 0);
        const del = evs.reduce((s, e) => s + (Number(e.deletions) || 0), 0);
        const paths = [...new Set(evs.flatMap((e) => e.filePaths ?? []))].slice(0, 8);
        // GitLab 证据没有行数统计，避免把 0 误当作"没有改动"
        const lineInfo = add || del ? `，+${add}/-${del} 行` : "（无行数统计）";
        lines.push(`   代码证据：${evs.length} 个提交，${files} 个文件${lineInfo}`);
        if (paths.length) lines.push(`   主要文件：${paths.join(", ")}`);
        // 篇幅按提交平均分配，避免前一两个提交占满预算
        const withDiff = evs.filter((e) => e.diffExcerpt);
        const perCommit = Math.floor(excerptBudget / Math.max(1, withDiff.length));
        const excerpt = withDiff
          .map((e) => e.diffExcerpt!.slice(0, perCommit))
          .join("\n");
        if (excerpt) {
          lines.push(
            `   改动摘录：\n${excerpt
              .split("\n")
              .map((l) => "     " + l)
              .join("\n")}`
          );
        }
      } else {
        lines.push("   代码证据：未获取到");
      }
      return lines.join("\n");
    });

    const contextText =
      typeof projectContext === "string"
        ? projectContext.slice(0, Math.floor(MAX_CONTEXT_CHARS / 2))
        : "";
    const ai = await chatJson(
      aiCfg,
      SYSTEM_PROMPT,
      `${
        contextText ? `项目背景（摘自仓库文档）：\n${contextText}\n\n` : ""
      }仓库：${repo ?? "未知"}\n成果数量：${achievements.length}\n\n成果与代码证据：\n${blocks.join("\n")}`,
      { timeoutMs: 60000, temperature: 0.2 }
    );
    if (!ai.ok) {
      return NextResponse.json({ error: ai.error }, { status: ai.status });
    }
    const parsed = (ai.data ?? {}) as { items?: unknown; assumptions?: unknown };
    type RawItem = {
      index?: unknown;
      hoursLow?: unknown;
      hoursHigh?: unknown;
      basis?: unknown;
      tasks?: unknown;
    };

    // ---- 归一化：按 index 对齐，缺失项给 0 并提示手动填写 ----
    const byIndex = new Map<number, RawItem>();
    for (const it of (Array.isArray(parsed.items) ? parsed.items : []) as RawItem[]) {
      const idx = Number(it?.index);
      if (Number.isInteger(idx) && idx >= 1 && idx <= achievements.length) {
        byIndex.set(idx, it);
      }
    }
    const clamp = (n: unknown) => {
      const v = Number(n);
      return Number.isFinite(v) ? Math.min(Math.max(v, 0), MAX_HOURS) : 0;
    };

    const items: EstimateItem[] = achievements.map((_, i) => {
      const raw = byIndex.get(i + 1);
      if (!raw) {
        return {
          index: i,
          hoursLow: 0,
          hoursHigh: 0,
          basis: "AI 未给出该项估算，请手动填写",
        };
      }
      const low = clamp(raw.hoursLow);
      const high = Math.max(low, clamp(raw.hoursHigh));
      return {
        index: i,
        hoursLow: low,
        hoursHigh: high,
        basis: String(raw.basis ?? "").slice(0, 80),
        tasks: normalizeTasks(raw.tasks, low, high),
      };
    });

    if (items.every((it) => it.hoursHigh === 0)) {
      return NextResponse.json(
        { error: "AI 未能给出有效估算，请重试一次" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      items,
      assumptions: String(parsed?.assumptions ?? "").slice(0, 160),
    });
  } catch (e) {
    console.error("[estimate] exception:", e);
    return NextResponse.json(
      { error: "估算请求失败，请稍后重试" },
      { status: 500 }
    );
  }
}
