import type {
  Achievement,
  AchievementCategory,
  ImpactLevel,
  ReportContent,
} from "@/lib/types";

/**
 * 模型输出的防御性归一化（截断长度、枚举白名单）。
 * 纯函数、无服务端依赖：analyze / merge 接口与前端的降级拼接共用。
 */

export const CATEGORIES: AchievementCategory[] = [
  "feature",
  "performance",
  "experience",
  "stability",
  "efficiency",
  "security",
  "other",
];
export const IMPACTS: ImpactLevel[] = ["high", "medium", "low"];

/** 客户报告的条目上限 */
export const MAX_REPORT_ITEMS = 12;

/** 报告中风险与待跟进事项的条数上限 */
export const MAX_REPORT_RISKS = 3;

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

/** 归一化成果的文案字段；shas / evidence 由调用方决定来源 */
export function normalizeAchievementText(
  raw: unknown
): Omit<Achievement, "shas" | "evidence"> | null {
  const a = asRecord(raw);
  if (!a || typeof a.title !== "string" || typeof a.description !== "string") {
    return null;
  }
  const description = a.description.slice(0, 300);
  return {
    title: a.title.slice(0, 40),
    description,
    value:
      typeof a.value === "string" && a.value.trim()
        ? a.value.slice(0, 160)
        : description.slice(0, 160),
    status: a.status === "unverified" ? "unverified" : "evidenced",
    note: typeof a.note === "string" ? a.note.slice(0, 40) : "",
    category: CATEGORIES.includes(a.category as AchievementCategory)
      ? (a.category as AchievementCategory)
      : "other",
    impact: IMPACTS.includes(a.impact as ImpactLevel)
      ? (a.impact as ImpactLevel)
      : "medium",
  };
}

/** 归一化模型直接产出的成果（含 shas 解析与 evidence 截断） */
export function normalizeAchievement(
  raw: unknown,
  resolveSha: (s: unknown) => string | undefined
): Achievement | null {
  const text = normalizeAchievementText(raw);
  if (!text) return null;
  const a = raw as Raw;
  return {
    ...text,
    shas: Array.isArray(a.shas)
      ? [
          ...new Set(
            a.shas.map(resolveSha).filter((s): s is string => !!s)
          ),
        ]
      : [],
    evidence: Array.isArray(a.evidence)
      ? a.evidence
          .map((e) => String(e).slice(0, 80))
          .filter(Boolean)
          .slice(0, 4)
      : [],
  };
}

/** 无报告或报告不可用时，按成果卡生成条目 */
export function reportFromAchievements(achievements: Achievement[]): ReportContent {
  return {
    summary: "",
    items: achievements.slice(0, MAX_REPORT_ITEMS).map((a) => ({
      title: a.title,
      detail: a.value,
      status: a.status,
    })),
    nextSteps: "",
    risks: [],
  };
}

export function normalizeReport(
  raw: unknown,
  achievements: Achievement[]
): ReportContent {
  const r = asRecord(raw);
  if (!r) return reportFromAchievements(achievements);
  const items = Array.isArray(r.items)
    ? r.items.slice(0, MAX_REPORT_ITEMS).map((it) => {
        const x = asRecord(it) ?? {};
        return {
          title: String(x.title ?? "").slice(0, 40),
          detail: String(x.detail ?? "").slice(0, 160),
          status: (x.status === "unverified" ? "unverified" : "evidenced") as
            | "evidenced"
            | "unverified",
        };
      })
    : reportFromAchievements(achievements).items;
  return {
    summary: String(r.summary ?? "").slice(0, 120),
    items,
    nextSteps: String(r.nextSteps ?? "").slice(0, 160),
    risks: Array.isArray(r.risks)
      ? r.risks
          .map((x) => (typeof x === "string" ? x.trim().slice(0, 80) : ""))
          .filter(Boolean)
          .slice(0, MAX_REPORT_RISKS)
      : [],
  };
}
