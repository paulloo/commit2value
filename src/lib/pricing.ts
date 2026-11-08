import type {
  EstimateItem,
  EstimateTask,
  PricingSettings,
  QuoteForExport,
  WorkUnit,
} from "@/lib/types";

export const DEFAULT_PRICING: PricingSettings = {
  currency: "CNY",
  unit: "day",
  costRate: 1500,
  marginPct: 30,
  hoursPerDay: 8,
};

export const UNIT_LABEL: Record<WorkUnit, string> = {
  hour: "小时",
  day: "人天",
};

/** 合并用户已保存的参数与默认值，并剔除非法数值 */
export function normalizePricing(p?: Partial<PricingSettings>): PricingSettings {
  const num = (v: unknown, fallback: number, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    currency: (p?.currency ?? "").trim() || DEFAULT_PRICING.currency,
    unit: p?.unit === "hour" ? "hour" : "day",
    costRate: num(p?.costRate, DEFAULT_PRICING.costRate, 0),
    marginPct: num(p?.marginPct, DEFAULT_PRICING.marginPct, 0),
    hoursPerDay: num(p?.hoursPerDay, DEFAULT_PRICING.hoursPerDay, 1),
  };
}

/** AI 区间的默认取值：区间中点，按 0.5 小时取整 */
export function defaultHours(item: EstimateItem): number {
  return Math.round(((item.hoursLow + item.hoursHigh) / 2) * 2) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 用户改了总工时后，子任务按 AI 给出的比例缩放；精度 0.1 小时，
 * 舍入误差记到最后一项，保证子任务合计等于总工时。
 */
export function scaleTasks(tasks: EstimateTask[] | undefined, hours: number): EstimateTask[] {
  const list = tasks ?? [];
  const sum = list.reduce((s, t) => s + t.hours, 0);
  if (!list.length || sum <= 0 || hours <= 0) return [];
  const scaled = list.map((t) => ({
    name: t.name,
    hours: Math.round((t.hours / sum) * hours * 10) / 10,
  }));
  const diff = Math.round((hours - scaled.reduce((s, t) => s + t.hours, 0)) * 10) / 10;
  scaled[scaled.length - 1].hours = Math.max(0, round2(scaled[scaled.length - 1].hours + diff));
  return scaled;
}

export interface QuoteLine {
  index: number;
  title: string;
  hours: number;
  /** 已按 hours 缩放的子任务（小时） */
  tasks: EstimateTask[];
  /** 按计价单位折算后的数量 */
  quantity: number;
  cost: number;
  price: number;
}

export interface QuoteSummary {
  lines: QuoteLine[];
  totalHours: number;
  totalQuantity: number;
  totalCost: number;
  totalPrice: number;
}

/**
 * 金额全部在这里确定性计算，AI 只提供工时。
 * 成本 = 数量 × 成本费率；报价 = 成本 × (1 + 利润率)。
 */
export function computeQuote(
  rows: Array<{ index: number; title: string; hours: number; tasks?: EstimateTask[] }>,
  pricing: PricingSettings
): QuoteSummary {
  const lines = rows.map((r) => {
    const hours = Math.max(0, r.hours);
    const quantity =
      pricing.unit === "day" ? round2(hours / pricing.hoursPerDay) : hours;
    const cost = round2(quantity * pricing.costRate);
    const price = round2(cost * (1 + pricing.marginPct / 100));
    const tasks = scaleTasks(r.tasks, hours);
    return { index: r.index, title: r.title, hours, tasks, quantity, cost, price };
  });
  return {
    lines,
    totalHours: round2(lines.reduce((s, l) => s + l.hours, 0)),
    totalQuantity: round2(lines.reduce((s, l) => s + l.quantity, 0)),
    totalCost: round2(lines.reduce((s, l) => s + l.cost, 0)),
    totalPrice: round2(lines.reduce((s, l) => s + l.price, 0)),
  };
}

/** 导出给客户的部分：只含数量与报价，不含成本与利润率 */
export function toExportQuote(
  summary: QuoteSummary,
  pricing: PricingSettings
): QuoteForExport {
  return {
    currency: pricing.currency,
    unitLabel: UNIT_LABEL[pricing.unit],
    lines: summary.lines.map((l) => ({
      title: l.title,
      quantity: l.quantity,
      amount: l.price,
      tasks: l.tasks.map((t) => ({
        name: t.name,
        quantity: pricing.unit === "day" ? round2(t.hours / pricing.hoursPerDay) : t.hours,
      })),
    })),
    totalQuantity: summary.totalQuantity,
    totalAmount: summary.totalPrice,
  };
}

export function formatMoney(n: number, currency: string): string {
  return `${currency} ${n.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}
