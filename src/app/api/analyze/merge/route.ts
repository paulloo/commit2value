import { NextResponse } from "next/server";
import {
  AI_NOT_CONFIGURED_MESSAGE,
  chatJson,
  resolveAiConfig,
} from "@/lib/ai";
import {
  MAX_REPORT_ITEMS,
  MAX_REPORT_RISKS,
  normalizeAchievementText,
  normalizeReport,
  reportFromAchievements,
} from "@/lib/achievements";
import { MAX_MERGE_ACHIEVEMENTS } from "@/lib/limits";
import { MAX_CONTEXT_CHARS } from "@/lib/project-docs";
import type { Achievement } from "@/lib/types";

const SYSTEM_PROMPT = `你是一名资深技术项目经理。一段时间内的提交被拆成多批分别归纳成了工作成果，现在需要你把它们整合成一份面向客户的成果汇报。

【任务一：合并重复成果 merges】
1. 不同批次可能把同一功能、同一模块的连续工作拆成了多条成果，请把它们合并为一条。只合并确实是同一件事的成果，不要为了减少条数而合并不相关的工作。
2. 只输出需要合并的分组（sources 至少 2 个编号）。未出现在任何分组中的成果会原样保留，不要输出它们。
3. 每个编号最多出现在一个分组里。
4. 合并后的 title（8-18 字）、description（1-2 句）、value（1 句，写对客户的意义）要覆盖各来源的内容，只依据给定文字，严禁编造功能、指标或数字。
5. category 取 feature/performance/experience/stability/efficiency/security/other 之一；impact 取 high/medium/low；任一来源为 unverified 时 status 取 unverified，并在 note 用 15 字内说明验证方式。

输入开头可能附有项目背景（摘自仓库文档），只用于理解业务术语、让报告措辞贴合业务，不能据此新增成果。

【任务二：撰写报告 report】
- summary：一句话总览这段时间整体交付了什么。
- items：挑选最重要的成果（合并后视角，不超过 ${MAX_REPORT_ITEMS} 条），detail 写对客户的价值。
- nextSteps：1-2 句说明后续如何跟进上线效果与下一步计划。
- risks：0-${MAX_REPORT_RISKS} 条风险与待跟进事项，每条一句、不超过 40 字。只写各成果描述中能直接看出的问题，例如标注为临时方案或待完善的改动、只完成一部分的迁移、改动核心逻辑却没有相应测试、为兼容保留的旧代码。没有明确依据时输出空数组，严禁凭空推测。
- 全文使用中文，不使用 Markdown 符号，控制在 500 字内。
- 禁止使用"赋能""抓手""闭环"这类空洞的营销词。

严格输出如下 JSON 对象，不要输出任何其他文本：
{"merges":[{"sources":[1,4],"title":"","description":"","value":"","status":"evidenced","note":"","category":"feature","impact":"high"}],"report":{"summary":"","items":[{"title":"","detail":"","status":"evidenced"}],"nextSteps":"","risks":[""]}}`;

/**
 * 合并多批分析的成果并撰写总报告。
 *
 * shas 与 evidence 由服务端按 sources 取并集，不交给模型重写，保证可追溯；
 * 模型调用失败时降级为按批次直接拼接（附 warning），不让前面各批的分析白费。
 */
export async function POST(req: Request) {
  try {
    const {
      repo,
      branches,
      commitCount,
      achievements,
      projectContext,
      settings,
    }: {
      repo?: string;
      branches?: string[];
      commitCount?: number;
      achievements?: Achievement[];
      projectContext?: string;
      settings?: { baseUrl?: string; apiKey?: string; model?: string };
    } = await req.json();

    if (!Array.isArray(achievements) || achievements.length === 0) {
      return NextResponse.json({ error: "没有可合并的成果" }, { status: 400 });
    }
    if (achievements.length > MAX_MERGE_ACHIEVEMENTS) {
      return NextResponse.json(
        { error: `单次最多合并 ${MAX_MERGE_ACHIEVEMENTS} 条成果` },
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

    const sources = achievements.map((a) => ({
      ...a,
      shas: Array.isArray(a.shas) ? a.shas.map(String) : [],
      evidence: Array.isArray(a.evidence) ? a.evidence.map(String) : [],
    }));

    const lines = sources
      .map(
        (a, i) =>
          `${i + 1}. [${a.category ?? "other"}/${a.impact ?? "medium"}/${a.status}] ${a.title}\n   描述：${String(
            a.description ?? ""
          ).slice(0, 200)}\n   价值：${String(a.value ?? "").slice(0, 120)}\n   关联提交数：${a.shas.length}`
      )
      .join("\n");

    const branchLabel =
      Array.isArray(branches) && branches.length ? branches.join("、") : "未知";
    // 合并只需要背景帮助措辞，给一半篇幅即可
    const contextText =
      typeof projectContext === "string"
        ? projectContext.slice(0, Math.floor(MAX_CONTEXT_CHARS / 2))
        : "";
    const ai = await chatJson(
      aiCfg,
      SYSTEM_PROMPT,
      `${
        contextText ? `项目背景（摘自仓库文档，不是本期成果）：\n${contextText}\n\n` : ""
      }仓库：${repo ?? "未知"}\n分支：${branchLabel}\n提交总数：${
        Number(commitCount) || "未知"
      }\n成果数：${sources.length}\n\n各批成果：\n${lines}`,
      { timeoutMs: 75000, temperature: 0.2 }
    );

    if (!ai.ok) {
      console.error("[merge] AI failed, degrade to concat:", ai.status, ai.error);
      return NextResponse.json({
        achievements: sources,
        report: reportFromAchievements(sources),
        warning: `成果合并失败（${ai.error}），已按批次直接拼接，可能存在重复成果。`,
      });
    }

    const parsed = (ai.data ?? {}) as { merges?: unknown; report?: unknown };

    // ---- 校验分组：编号合法、未被占用、至少 2 个来源，否则忽略该分组 ----
    const used = new Set<number>();
    const groupAt = new Map<number, Achievement>();
    for (const g of Array.isArray(parsed.merges) ? parsed.merges : []) {
      const rawSources = (g as { sources?: unknown })?.sources;
      if (!Array.isArray(rawSources)) continue;
      const idx = [
        ...new Set(
          rawSources
            .map((n) => Number(n) - 1)
            .filter(
              (n) => Number.isInteger(n) && n >= 0 && n < sources.length && !used.has(n)
            )
        ),
      ].sort((a, b) => a - b);
      if (idx.length < 2) continue;
      const text = normalizeAchievementText(g);
      if (!text) continue;
      idx.forEach((n) => used.add(n));
      groupAt.set(idx[0], {
        ...text,
        shas: [...new Set(idx.flatMap((n) => sources[n].shas))],
        evidence: [...new Set(idx.flatMap((n) => sources[n].evidence))].slice(0, 4),
      });
    }

    // 按首个来源的位置排列：合并项占据其首个来源的位置，其余来源移除，未合并的原样保留
    const merged: Achievement[] = [];
    sources.forEach((a, i) => {
      const g = groupAt.get(i);
      if (g) merged.push(g);
      else if (!used.has(i)) merged.push(a);
    });

    return NextResponse.json({
      achievements: merged,
      report: normalizeReport(parsed.report, merged),
    });
  } catch (e) {
    console.error("[merge] exception:", e);
    return NextResponse.json({ error: "合并请求失败，请稍后重试" }, { status: 500 });
  }
}
