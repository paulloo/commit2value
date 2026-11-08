import { CATEGORIES } from "@/lib/achievements";
import { buildHeatmap, localDayKey, type HeatmapData } from "@/lib/heatmap";

export { shortDay } from "@/lib/heatmap";
import type { Achievement, AchievementCategory, CommitItem } from "@/lib/types";

/**
 * 报告的详细章节：全部由已有数据在前端推导，不额外调用 AI、不增加输出 token。
 * - 按类别的工作明细：列出全部成果（报告 items 只挑重点）
 * - 按周时间线：每周提交数 + 当周完成的成果（以成果最后一个关联提交的日期为完成时间）
 * - 热力图：覆盖本次分析提交的起止日期
 */

export interface CategoryGroup {
  category: AchievementCategory;
  items: Array<{ title: string; description: string; commitCount: number }>;
}

export interface TimelineWeek {
  /** 本地日期 YYYY-MM-DD（周一，或范围首日） */
  start: string;
  /** 本地日期 YYYY-MM-DD（周日，或范围末日） */
  end: string;
  commitCount: number;
  completed: string[];
}

export interface ReportDetails {
  categories: CategoryGroup[];
  /** 不足两周时为空：单周时间线没有信息量 */
  timeline: TimelineWeek[];
  heatmap: HeatmapData | null;
}

export function buildReportDetails(
  achievements: Achievement[],
  commits: CommitItem[]
): ReportDetails {
  const categories: CategoryGroup[] = CATEGORIES.map((category) => ({
    category,
    items: achievements
      .filter((a) => (a.category ?? "other") === category)
      .map((a) => ({
        title: a.title,
        description: a.description,
        commitCount: a.shas.length,
      })),
  })).filter((g) => g.items.length > 0);

  const times = commits
    .map((c) => new Date(c.date))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (times.length === 0) return { categories, timeline: [], heatmap: null };

  const first = times[0];
  const last = times[times.length - 1];
  const heatmap = buildHeatmap(
    commits.map((c) => c.date),
    first,
    last
  );

  // 成果完成时间 = 其关联提交中最晚的一个
  const dateByShort = new Map(commits.map((c) => [c.shortSha, c.date]));
  const completedAt = achievements.map((a) => {
    const ds = a.shas
      .map((s) => dateByShort.get(s))
      .filter((d): d is string => !!d)
      .map((d) => new Date(d).getTime())
      .filter((t) => !Number.isNaN(t));
    return ds.length ? localDayKey(new Date(Math.max(...ds))) : null;
  });

  const timeline: TimelineWeek[] = heatmap.weeks
    .map((col) => {
      const cells = col.filter((c): c is NonNullable<typeof c> => !!c);
      const start = cells[0].key;
      const end = cells[cells.length - 1].key;
      return {
        start,
        end,
        commitCount: cells.reduce((s, c) => s + c.count, 0),
        completed: achievements
          .filter((_, i) => {
            const k = completedAt[i];
            return k !== null && k >= start && k <= end;
          })
          .map((a) => a.title),
      };
    })
    .filter((w) => w.commitCount > 0 || w.completed.length > 0);

  return {
    categories,
    timeline: heatmap.weeks.length >= 2 ? timeline : [],
    heatmap,
  };
}
