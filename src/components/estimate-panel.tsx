"use client";

import { Calculator, Info, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UNIT_LABEL, formatMoney, type QuoteSummary } from "@/lib/pricing";
import type { EstimateResult, PricingSettings } from "@/lib/types";

interface Props {
  titles: string[];
  estimate: EstimateResult | null;
  /** 用户确认后的工时（小时），按成果下标 */
  hours: Record<number, number>;
  onHoursChange: (index: number, hours: number) => void;
  pricing: PricingSettings;
  onPricingChange: (p: PricingSettings) => void;
  summary: QuoteSummary | null;
  loading: boolean;
  error: string | null;
  onEstimate: () => void;
}

function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function EstimatePanel({
  titles,
  estimate,
  hours,
  onHoursChange,
  pricing,
  onPricingChange,
  summary,
  loading,
  error,
  onEstimate,
}: Props) {
  const unitLabel = UNIT_LABEL[pricing.unit];
  const numInput = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  return (
    <div className="space-y-4">
      {/* 计价参数 */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/30 p-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="pricing-unit" className="text-xs">计价单位</Label>
          <select
            id="pricing-unit"
            value={pricing.unit}
            onChange={(e) =>
              onPricingChange({
                ...pricing,
                unit: e.target.value === "hour" ? "hour" : "day",
              })
            }
            className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="day">人天</option>
            <option value="hour">小时</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pricing-rate" className="text-xs">
            成本费率（/{unitLabel}）
          </Label>
          <Input
            id="pricing-rate"
            type="number"
            min={0}
            value={pricing.costRate}
            onChange={(e) =>
              onPricingChange({ ...pricing, costRate: numInput(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pricing-margin" className="text-xs">利润率（%）</Label>
          <Input
            id="pricing-margin"
            type="number"
            min={0}
            value={pricing.marginPct}
            onChange={(e) =>
              onPricingChange({ ...pricing, marginPct: numInput(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pricing-currency" className="text-xs">币种</Label>
          <Input
            id="pricing-currency"
            value={pricing.currency}
            onChange={(e) => onPricingChange({ ...pricing, currency: e.target.value })}
          />
        </div>
        {pricing.unit === "day" && (
          <div className="col-span-2 space-y-1 sm:col-span-1">
            <Label htmlFor="pricing-hpd" className="text-xs">每人天小时数</Label>
            <Input
              id="pricing-hpd"
              type="number"
              min={1}
              value={pricing.hoursPerDay}
              onChange={(e) =>
                onPricingChange({
                  ...pricing,
                  hoursPerDay: Math.max(1, numInput(e.target.value)),
                })
              }
            />
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {!estimate && !loading && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            AI 会根据每条成果关联的提交与代码改动给出工时区间和子任务拆分，
            <br />
            金额按上方费率计算，工时可逐条手动调整，子任务随之按比例缩放。
          </p>
          <Button onClick={onEstimate}>
            <Calculator />
            估算工作量
          </Button>
        </div>
      )}

      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" />
          正在根据代码证据估算工时…
        </p>
      )}

      {estimate && summary && !loading && (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">成果</th>
                  <th className="px-3 py-2 text-right font-medium">AI 区间（h）</th>
                  <th className="px-3 py-2 text-right font-medium">工时（h）</th>
                  {pricing.unit === "day" && (
                    <th className="px-3 py-2 text-right font-medium">人天</th>
                  )}
                  <th className="px-3 py-2 text-right font-medium">成本</th>
                  <th className="px-3 py-2 text-right font-medium">报价</th>
                </tr>
              </thead>
              <tbody>
                {summary.lines.map((l) => {
                  const ai = estimate.items.find((it) => it.index === l.index);
                  return (
                    <tr key={l.index} className="border-t align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{titles[l.index]}</div>
                        {ai?.basis && (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {ai.basis}
                          </div>
                        )}
                        {l.tasks.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5 border-l-2 border-primary/20 pl-2 text-xs">
                            {l.tasks.map((t, k) => (
                              <li key={k} className="flex justify-between gap-3">
                                <span>{t.name}</span>
                                <span className="whitespace-nowrap text-muted-foreground">
                                  {fmtNum(t.hours)} h
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                        {ai ? `${fmtNum(ai.hoursLow)}–${fmtNum(ai.hoursHigh)}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          step={0.5}
                          aria-label={`${titles[l.index]} 工时`}
                          className="ml-auto h-8 w-20 text-right"
                          value={hours[l.index] ?? 0}
                          onChange={(e) => onHoursChange(l.index, numInput(e.target.value))}
                        />
                      </td>
                      {pricing.unit === "day" && (
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {fmtNum(l.quantity)}
                        </td>
                      )}
                      <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                        {formatMoney(l.cost, pricing.currency)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                        {formatMoney(l.price, pricing.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t bg-muted/30 font-semibold">
                <tr>
                  <td className="px-3 py-2">合计</td>
                  <td />
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {fmtNum(summary.totalHours)}
                  </td>
                  {pricing.unit === "day" && (
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {fmtNum(summary.totalQuantity)}
                    </td>
                  )}
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {formatMoney(summary.totalCost, pricing.currency)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-primary">
                    {formatMoney(summary.totalPrice, pricing.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {estimate.assumptions && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              估算前提：{estimate.assumptions}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5" />
              成本与利润率仅供内部查看，不会出现在导出的客户汇报中。
            </p>
            <Button size="sm" variant="ghost" onClick={onEstimate}>
              <RefreshCw />
              重新估算
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
