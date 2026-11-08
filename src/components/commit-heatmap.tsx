"use client";

import { Fragment, useMemo, useState } from "react";
import type { CommitItem } from "@/lib/types";
import {
  CALENDAR_MAX_WEEKS,
  HEAT_COLORS,
  shortDay,
  WEEKDAY_LABELS,
  buildHeatmap,
  formatDayKey,
  type HeatCell,
  type HeatmapData,
} from "@/lib/heatmap";
import { cn } from "@/lib/utils";

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const LEFT = 18; // 星期标签宽度
const TOP = 14; // 月份标签高度

/**
 * 最近 rangeDays 天（截止今天）的热力图，统计的是已加载的提交；
 * partial = 还有未加载的分页，此时在图下注明，避免把稀疏误读为不活跃。
 */
export function RecentCommitHeatmap({
  commits,
  rangeDays,
  partial,
  className,
}: {
  commits: CommitItem[];
  rangeDays: number;
  partial?: boolean;
  className?: string;
}) {
  const data = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (rangeDays - 1));
    return buildHeatmap(
      commits.map((c) => c.date),
      start,
      end
    );
  }, [commits, rangeDays]);
  return (
    <CommitHeatmap
      data={data}
      className={className}
      note={partial ? `仅统计已加载的 ${commits.length} 条提交，加载更多后热力图会更完整。` : undefined}
    />
  );
}

/** GitHub 风格的提交热力图（纯 SVG），渲染预先算好的数据 */
export function CommitHeatmap({
  data,
  note,
  className,
}: {
  data: HeatmapData;
  note?: string;
  className?: string;
}) {
  const [hover, setHover] = useState<HeatCell | null>(null);

  const width = LEFT + data.weeks.length * STEP;
  const height = TOP + 7 * STEP;

  const tip = (c: HeatCell) =>
    `${formatDayKey(c.key)}：${c.count ? `${c.count} 次提交` : "无提交"}`;

  return (
    <div className={cn("space-y-2", className)}>
      {data.weeks.length <= CALENDAR_MAX_WEEKS ? (
        /* 短范围：日历视图，每行一周，格子更大并标出日期 */
        <div
          role="img"
          aria-label={`最近 ${data.days} 天共 ${data.total} 次提交，${data.activeDays} 天有提交`}
          className="grid max-w-md grid-cols-[auto_repeat(7,minmax(0,1fr))] items-center gap-1"
          onMouseLeave={() => setHover(null)}
        >
          <span />
          {WEEKDAY_LABELS.map((l) => (
            <span key={l} className="text-center text-[10px] text-muted-foreground">
              {l}
            </span>
          ))}
          {data.weeks.map((col) => {
            const first = col.find((c): c is HeatCell => !!c);
            return (
              <Fragment key={first?.key}>
                <span className="pr-1 text-right text-[10px] text-muted-foreground">
                  {first ? shortDay(first.key) : ""}
                </span>
                {col.map((cell, d) =>
                  cell ? (
                    <div
                      key={cell.key}
                      title={tip(cell)}
                      onMouseEnter={() => setHover(cell)}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md text-[11px] font-medium",
                        cell.level >= 3 ? "text-white" : "text-slate-600",
                        hover?.key === cell.key && "ring-2 ring-slate-900/70"
                      )}
                      style={{ backgroundColor: HEAT_COLORS[cell.level] }}
                    >
                      {Number(cell.key.slice(8))}
                    </div>
                  ) : (
                    <div key={`empty-${d}`} />
                  )
                )}
              </Fragment>
            );
          })}
        </div>
      ) : (
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`最近 ${data.days} 天共 ${data.total} 次提交，${data.activeDays} 天有提交`}
          className="block"
          onMouseLeave={() => setHover(null)}
        >
          {data.months.map((m) => (
            <text
              key={m.col}
              x={LEFT + m.col * STEP}
              y={10}
              className="fill-muted-foreground text-[10px]"
            >
              {m.label}
            </text>
          ))}
          {[0, 2, 4].map((row) => (
            <text
              key={row}
              x={0}
              y={TOP + row * STEP + CELL - 2}
              className="fill-muted-foreground text-[10px]"
            >
              {WEEKDAY_LABELS[row]}
            </text>
          ))}
          {data.weeks.map((col, w) =>
            col.map((cell, d) =>
              cell ? (
                <rect
                  key={cell.key}
                  x={LEFT + w * STEP}
                  y={TOP + d * STEP}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={HEAT_COLORS[cell.level]}
                  stroke={hover?.key === cell.key ? "#0f172a" : "none"}
                  strokeWidth={1}
                  onMouseEnter={() => setHover(cell)}
                >
                  <title>{tip(cell)}</title>
                </rect>
              ) : null
            )
          )}
        </svg>
      </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-h-4">
          {hover
            ? `${formatDayKey(hover.key)}：${hover.count ? `${hover.count} 次提交` : "无提交"}`
            : `${data.activeDays}/${data.days} 天有提交 · 最长连续 ${data.longestStreak} 天${
                data.busiest ? ` · 最多 ${data.busiest.count} 次（${formatDayKey(data.busiest.key)}）` : ""
              }`}
        </span>
        <span className="flex items-center gap-1">
          少
          {HEAT_COLORS.map((c) => (
            <span
              key={c}
              className="inline-block size-2.75 rounded-[2px]"
              style={{ backgroundColor: c }}
            />
          ))}
          多
        </span>
      </div>
      {note && <p className="text-xs text-amber-600">{note}</p>}
    </div>
  );
}
