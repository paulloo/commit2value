/**
 * 提交热力图的纯计算（无 DOM 依赖）：页面组件与 Word 导出共用。
 *
 * - 按浏览器本地时区分天：用 ISO 字符串前 10 位（UTC）会把晚间提交算到错误的日期。
 * - 网格按周排列、周一开头；范围外的格子为 null（不画），与"当天 0 次提交"区分。
 * - 颜色分档用非零天数的分位数而非线性：个别爆发日不会把其余格子都压成最浅色。
 */

export interface HeatCell {
  /** 本地日期 YYYY-MM-DD */
  key: string;
  count: number;
  /** 0 = 无提交，1-4 = 由浅到深 */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatmapData {
  /** 每列一周，每列 7 格（周一 → 周日），范围外为 null */
  weeks: Array<Array<HeatCell | null>>;
  /** 月份标签所在列 */
  months: Array<{ col: number; label: string }>;
  total: number;
  activeDays: number;
  /** 最长连续有提交天数 */
  longestStreak: number;
  busiest: { key: string; count: number } | null;
  /** 范围内总天数 */
  days: number;
}

/** 0 档用浅灰，1-4 档为 emerald 200/400/600/800，与主题主色一致 */
export const HEAT_COLORS = ["#ebedf0", "#a7f3d0", "#34d399", "#059669", "#065f46"] as const;

export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/**
 * 不超过该周数时改用日历视图（每行一周、周一到周日横排）：
 * 横向的 GitHub 样式在一两周时只有一两列，几乎看不出内容。
 */
export const CALENDAR_MAX_WEEKS = 5;

/** "2026-11-03" → "11/3" */
export function shortDay(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 用年月日构造而不是加毫秒，避免夏令时切换日错位 */
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** "2026-11-03" → "11月3日 周二" */
export function formatDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}月${d}日 周${WEEKDAY_LABELS[(date.getDay() + 6) % 7]}`;
}

export function buildHeatmap(dates: string[], start: Date, end: Date): HeatmapData {
  let from = startOfDay(start);
  let to = startOfDay(end);
  if (to < from) [from, to] = [to, from];

  const counts = new Map<string, number>();
  for (const iso of dates) {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) continue;
    const day = startOfDay(t);
    if (day < from || day > to) continue;
    const k = localDayKey(day);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  // 分位数阈值：只看有提交的天
  const nonzero = [...counts.values()].sort((a, b) => a - b);
  const q = (p: number) =>
    nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * p))] : 0;
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);
  const levelOf = (c: number): HeatCell["level"] =>
    c <= 0 ? 0 : ((1 + (c > t1 ? 1 : 0) + (c > t2 ? 1 : 0) + (c > t3 ? 1 : 0)) as HeatCell["level"]);

  const gridStart = addDays(from, -((from.getDay() + 6) % 7));
  const weeks: HeatmapData["weeks"] = [];
  const months: HeatmapData["months"] = [];
  let streak = 0;
  let longestStreak = 0;
  let busiest: HeatmapData["busiest"] = null;
  let days = 0;

  for (let w = 0, cursor = gridStart; cursor <= to; w++) {
    const col: Array<HeatCell | null> = [];
    for (let i = 0; i < 7; i++, cursor = addDays(cursor, 1)) {
      if (cursor < from || cursor > to) {
        col.push(null);
        continue;
      }
      days++;
      const key = localDayKey(cursor);
      const count = counts.get(key) ?? 0;
      col.push({ key, count, level: levelOf(count) });
      streak = count > 0 ? streak + 1 : 0;
      longestStreak = Math.max(longestStreak, streak);
      if (count > 0 && (!busiest || count > busiest.count)) busiest = { key, count };
      // 范围首日或每月 1 日所在列标注月份
      if (key === localDayKey(from) || cursor.getDate() === 1) {
        const label = `${cursor.getMonth() + 1}月`;
        // 同一列内既有范围首日又有 1 日时，以新月份为准
        if (months.at(-1)?.col === w) months[months.length - 1].label = label;
        else months.push({ col: w, label });
      }
    }
    weeks.push(col);
  }

  // 首个标签与下一个挨得太近（不足 3 列）时去掉首个，避免文字重叠
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();

  return {
    weeks,
    months,
    total: nonzero.reduce((s, n) => s + n, 0),
    activeDays: nonzero.length,
    longestStreak,
    busiest,
    days,
  };
}
