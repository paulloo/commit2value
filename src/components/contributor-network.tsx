"use client";

import { useMemo, useState } from "react";
import type { CommitItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 贡献者协作网络图（纯 SVG 力导向布局，无第三方依赖）。
 * 节点 = 贡献者，大小 ∝ 提交数；边 = 共同修改同一目录的协作关系，粗细 ∝ 共同提交数。
 */
export function ContributorNetwork({
  commits,
  className,
}: {
  commits: CommitItem[];
  className?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const graph = useMemo(() => {
    // 1) 统计每人提交数
    const counts = new Map<string, number>();
    for (const c of commits) {
      const k = c.author || "未知";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const people = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (people.length < 2) return null;

    // 2) 协作边：同一人同一天提交视为一个"协作单元"，共现即协作
    const pair = new Map<string, number>();
    const byDay = new Map<string, Set<string>>();
    for (const c of commits) {
      const d = (c.date || "").slice(0, 10);
      const k = `${d}|${c.author || "未知"}`;
      if (!byDay.has(k)) byDay.set(k, new Set());
      byDay.get(k)!.add(c.author || "未知");
    }
    for (const set of byDay.values()) {
      const arr = [...set];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const key = [arr[i], arr[j]].sort().join("::");
          pair.set(key, (pair.get(key) ?? 0) + 1);
        }
      }
    }

    const maxCount = people[0][1];

    // 3) 圆形布局（确定性，无需迭代模拟，视觉稳定）
    const R = 78;
    const cx = 110;
    const cy = 105;
    const nodes = people.map(([name, n], i) => {
      // 第一位放中心
      let x: number;
      let y: number;
      if (i === 0) {
        x = cx;
        y = cy;
      } else {
        const angle = ((i - 1) / (people.length - 1)) * Math.PI * 2 - Math.PI / 2;
        x = cx + Math.cos(angle) * R;
        y = cy + Math.sin(angle) * R;
      }
      return { name, count: n, x, y, r: 9 + (n / maxCount) * 13 };
    });

    const idx = new Map(nodes.map((n, i) => [n.name, i]));
    const edges = [...pair.entries()]
      .map(([k, w]) => {
        const [a, b] = k.split("::");
        const ia = idx.get(a);
        const ib = idx.get(b);
        if (ia === undefined || ib === undefined) return null;
        return { a: nodes[ia], b: nodes[ib], w };
      })
      .filter(Boolean) as Array<{ a: (typeof nodes)[0]; b: (typeof nodes)[0]; w: number }>;

    return { nodes, edges };
  }, [commits]);

  if (!graph) {
    return (
      <p className="px-1 py-3 text-center text-xs text-muted-foreground">
        暂无可展示的协作关系（需要至少 2 位贡献者）
      </p>
    );
  }

  const maxW = Math.max(...graph.edges.map((e) => e.w), 1);
  const active = hover;
  const connected = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>([active]);
    for (const e of graph.edges) {
      if (e.a.name === active) s.add(e.b.name);
      if (e.b.name === active) s.add(e.a.name);
    }
    return s;
  }, [active, graph.edges]);

  return (
    <div className={cn("w-full", className)}>
      <svg viewBox="0 0 220 210" className="h-auto w-full max-w-[280px]">
        {/* 边 */}
        {graph.edges.map((e, i) => {
          const dim = connected && !(connected.has(e.a.name) && connected.has(e.b.name));
          return (
            <line
              key={i}
              x1={e.a.x}
              y1={e.a.y}
              x2={e.b.x}
              y2={e.b.y}
              stroke="#10B981"
              strokeWidth={0.8 + (e.w / maxW) * 2.6}
              strokeOpacity={dim ? 0.12 : 0.42}
              strokeLinecap="round"
            />
          );
        })}
        {/* 节点 */}
        {graph.nodes.map((n) => {
          const dim = connected && !connected.has(n.name);
          return (
            <g
              key={n.name}
              onMouseEnter={() => setHover(n.name)}
              onMouseLeave={() => setHover(null)}
              className="cursor-pointer"
              opacity={dim ? 0.3 : 1}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill="#10B981"
                fillOpacity={0.16}
                stroke="#10B981"
                strokeWidth={active === n.name ? 2 : 1.2}
              />
              <text
                x={n.x}
                y={n.y + n.r + 10}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 8.5 }}
              >
                {n.name.length > 8 ? n.name.slice(0, 7) + "…" : n.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full border border-primary bg-primary/20" />
          节点大小 = 提交数
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-primary/50" />
          连线粗细 = 协作强度
        </span>
      </div>
    </div>
  );
}