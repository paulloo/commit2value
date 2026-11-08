import type {
  AchievementCategory,
  ImpactLevel,
  QuoteForExport,
  ReportContent,
} from "@/lib/types";
import { formatMoney } from "@/lib/pricing";
import {
  CALENDAR_MAX_WEEKS,
  HEAT_COLORS,
  WEEKDAY_LABELS,
  formatDayKey,
  type HeatmapData,
} from "@/lib/heatmap";
import { shortDay, type ReportDetails } from "@/lib/report-details";

function fmtQty(n: number): string {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** 分类 → 中文标签 / Tailwind 配色 */
export const CATEGORY_META: Record<
  AchievementCategory,
  { label: string; chip: string; dot: string }
> = {
  feature: {
    label: "功能交付",
    chip: "bg-blue-50 text-blue-700 border-blue-200",
    dot: "bg-blue-500",
  },
  performance: {
    label: "性能优化",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    dot: "bg-amber-500",
  },
  experience: {
    label: "体验改进",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  stability: {
    label: "稳定性",
    chip: "bg-rose-50 text-rose-700 border-rose-200",
    dot: "bg-rose-500",
  },
  efficiency: {
    label: "工程效率",
    chip: "bg-violet-50 text-violet-700 border-violet-200",
    dot: "bg-violet-500",
  },
  security: {
    label: "安全合规",
    chip: "bg-slate-100 text-slate-700 border-slate-300",
    dot: "bg-slate-500",
  },
  other: {
    label: "其他",
    chip: "bg-slate-50 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
};

export const IMPACT_META: Record<
  ImpactLevel,
  { label: string; chip: string; bars: number }
> = {
  high: { label: "高影响", chip: "bg-red-50 text-red-700 border-red-200", bars: 3 },
  medium: {
    label: "中影响",
    chip: "bg-orange-50 text-orange-700 border-orange-200",
    bars: 2,
  },
  low: { label: "低影响", chip: "bg-slate-50 text-slate-600 border-slate-200", bars: 1 },
};

/** 导出选项：均可选，缺省时只输出 AI 报告本体 */
export interface ReportExportOptions {
  repo?: string;
  stats?: {
    commitCount?: number;
    additions?: number;
    deletions?: number;
    contributorCount?: number;
  };
  quote?: QuoteForExport;
  /** 前端推导的详细章节（按类别明细、按周时间线、热力图） */
  details?: ReportDetails;
}

type ReportLike = Pick<ReportContent, "summary" | "items" | "nextSteps" | "risks">;

function weekLabel(w: { start: string; end: string }) {
  return w.start === w.end ? shortDay(w.start) : `${shortDay(w.start)} - ${shortDay(w.end)}`;
}

/** 把结构化报告拼成可直接发送的纯文本 */
export function reportToText(report: ReportLike, opts: ReportExportOptions = {}): string {
  const { repo, quote, details } = opts;
  const lines: string[] = [];
  if (repo) lines.push(`【${repo} 阶段工作汇报】`);
  if (report.summary) lines.push("", report.summary);
  if (report.items.length) {
    lines.push("");
    report.items.forEach((it, i) => {
      const suffix = it.status === "unverified" ? "（上线后验证效果）" : "";
      lines.push(`${i + 1}. ${it.title}${suffix}`);
      if (it.detail) lines.push(`   ${it.detail}`);
    });
  }
  if (details?.categories.length) {
    lines.push("", "工作明细：");
    for (const g of details.categories) {
      lines.push(`【${CATEGORY_META[g.category].label}】`);
      for (const it of g.items) {
        lines.push(`- ${it.title}：${it.description}（${it.commitCount} 个提交）`);
      }
    }
  }
  if (details?.timeline.length) {
    lines.push("", "按周进展：");
    for (const w of details.timeline) {
      const done = w.completed.length ? `；完成：${w.completed.join("、")}` : "";
      lines.push(`- ${weekLabel(w)}：${w.commitCount} 次提交${done}`);
    }
  }
  if (report.risks?.length) {
    lines.push("", "风险与待跟进：");
    report.risks.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  if (report.nextSteps) {
    lines.push("");
    lines.push(`后续计划：${report.nextSteps}`);
  }
  if (quote && quote.lines.length) {
    lines.push("", "工作量与报价：");
    quote.lines.forEach((l, i) => {
      lines.push(
        `${i + 1}. ${l.title}：${fmtQty(l.quantity)} ${quote.unitLabel}，${formatMoney(l.amount, quote.currency)}`
      );
      for (const t of l.tasks ?? []) {
        lines.push(`   - ${t.name}：${fmtQty(t.quantity)} ${quote.unitLabel}`);
      }
    });
    lines.push(
      `合计：${fmtQty(quote.totalQuantity)} ${quote.unitLabel}，${formatMoney(quote.totalAmount, quote.currency)}`
    );
  }
  return lines.join("\n").trim();
}

/** 复制为 Markdown（方便贴进周报 / PR / 邮件） */
export function reportToMarkdown(report: ReportLike, opts: ReportExportOptions = {}): string {
  const { repo, quote, details } = opts;
  const cell = (t: string) => t.replace(/\|/g, "\\|");
  const lines: string[] = [];
  lines.push(`## ${repo ?? "阶段工作汇报"}`);
  if (report.summary) lines.push("", report.summary);
  if (report.items.length) {
    lines.push("");
    report.items.forEach((it) => {
      const suffix = it.status === "unverified" ? "（上线后验证）" : "";
      lines.push(`### ${it.title}${suffix}`);
      if (it.detail) lines.push(it.detail);
      lines.push("");
    });
  }
  if (details?.categories.length) {
    lines.push("", "### 工作明细");
    for (const g of details.categories) {
      lines.push("", `**${CATEGORY_META[g.category].label}**`, "");
      for (const it of g.items) {
        lines.push(`- **${it.title}**：${it.description}（${it.commitCount} 个提交）`);
      }
    }
  }
  if (details?.timeline.length) {
    lines.push("", "### 按周进展", "", "| 周 | 提交 | 完成的成果 |", "| --- | ---: | --- |");
    for (const w of details.timeline) {
      lines.push(`| ${weekLabel(w)} | ${w.commitCount} | ${cell(w.completed.join("、") || "—")} |`);
    }
  }
  if (report.risks?.length) {
    lines.push("", "### 风险与待跟进", "");
    report.risks.forEach((r) => lines.push(`- ${r}`));
  }
  if (report.nextSteps) lines.push("", `**后续计划**：${report.nextSteps}`);
  if (quote && quote.lines.length) {
    lines.push(
      "",
      "### 工作量与报价",
      "",
      `| 工作内容 | 工作量（${quote.unitLabel}） | 报价 |`,
      "| --- | ---: | ---: |"
    );
    quote.lines.forEach((l) => {
      lines.push(
        `| ${cell(l.title)} | ${fmtQty(l.quantity)} | ${formatMoney(l.amount, quote.currency)} |`
      );
      for (const t of l.tasks ?? []) {
        lines.push(`| └ ${cell(t.name)} | ${fmtQty(t.quantity)} | |`);
      }
    });
    lines.push(
      `| **合计** | **${fmtQty(quote.totalQuantity)}** | **${formatMoney(quote.totalAmount, quote.currency)}** |`
    );
  }
  return lines.join("\n").trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 热力图的 Word 版本：Word 对内联 SVG 支持不稳定，改用带底色的表格单元格。
 * 布局与页面一致：短范围为日历（每行一周、标出日期），长范围为每行一个星期几、每列一周。
 */
function heatmapToWordTable(h: HeatmapData): string {
  const label = "padding:0 4pt 0 0;font-size:7.5pt;color:#64748b;border:none;";
  if (h.weeks.length <= CALENDAR_MAX_WEEKS) {
    const day =
      "width:20pt;height:16pt;padding:0;border:2pt solid #ffffff;text-align:center;font-size:8pt;";
    const head = `<tr><td style="${label}"></td>${WEEKDAY_LABELS.map(
      (l) => `<td style="${label}text-align:center;">${l}</td>`
    ).join("")}</tr>`;
    const body = h.weeks
      .map((col) => {
        const first = col.find((c) => !!c);
        const cells = col
          .map((c) =>
            c
              ? `<td style="${day}background:${HEAT_COLORS[c.level]};color:${
                  c.level >= 3 ? "#ffffff" : "#475569"
                };" title="${escapeHtml(`${formatDayKey(c.key)}：${c.count} 次提交`)}">${Number(
                  c.key.slice(8)
                )}</td>`
              : `<td style="${day}"></td>`
          )
          .join("");
        return `<tr><td style="${label}text-align:right;">${first ? shortDay(first.key) : ""}</td>${cells}</tr>`;
      })
      .join("");
    return heatmapSection(h, head + body);
  }
  const box =
    "width:8pt;height:8pt;padding:0;border:1.5pt solid #ffffff;font-size:1pt;line-height:1pt;";
  const rows = WEEKDAY_LABELS.map((wd, d) => {
    const cells = h.weeks
      .map((col) => {
        const c = col[d];
        if (!c) return `<td style="${box}">&nbsp;</td>`;
        return `<td style="${box}background:${HEAT_COLORS[c.level]};" title="${escapeHtml(
          `${formatDayKey(c.key)}：${c.count} 次提交`
        )}">&nbsp;</td>`;
      })
      .join("");
    const tag = d === 0 || d === 2 || d === 4 ? wd : "";
    return `<tr><td style="${label}">${tag}</td>${cells}</tr>`;
  }).join("");
  return heatmapSection(h, rows);
}

function heatmapSection(h: HeatmapData, rows: string): string {
  const legend = HEAT_COLORS.map(
    (c) => `<span style="display:inline-block;width:8pt;height:8pt;background:${c};">&nbsp;</span>`
  ).join(" ");
  return `<h2 style="font-size:13pt;margin:18pt 0 6pt;">提交活跃度</h2>
  <table style="width:auto;border-collapse:collapse;">${rows}</table>
  <p style="color:#64748b;font-size:9pt;margin:4pt 0 0;">
    ${h.activeDays}/${h.days} 天有提交 · 最长连续 ${h.longestStreak} 天　少 ${legend} 多
  </p>`;
}

/**
 * 生成 Word 可直接打开的 HTML 文档（.doc）。
 * 相比 docx 库无需额外依赖，Word / WPS / Pages 均可正常打开并保留排版。
 */
export function reportToWordHtml(report: ReportLike, opts: ReportExportOptions = {}): string {
  const { repo, stats, quote, details } = opts;
  const esc = escapeHtml;
  const td = "padding:4pt 6pt;border-bottom:1px solid #e2e8f0;";
  const h2 = (t: string) => `<h2 style="font-size:13pt;margin:18pt 0 6pt;">${t}</h2>`;
  const quoteTable =
    quote && quote.lines.length
      ? `${h2("工作量与报价")}
  <table style="font-size:10.5pt;">
    <tr style="background:#f1f5f9;">
      <th style="${td}text-align:left;">工作内容</th>
      <th style="${td}text-align:right;">工作量（${esc(quote.unitLabel)}）</th>
      <th style="${td}text-align:right;">报价</th>
    </tr>
    ${quote.lines
      .map(
        (l) => `<tr>
      <td style="${td}">${esc(l.title)}</td>
      <td style="${td}text-align:right;">${fmtQty(l.quantity)}</td>
      <td style="${td}text-align:right;">${esc(formatMoney(l.amount, quote.currency))}</td>
    </tr>${(l.tasks ?? [])
      .map(
        (t) => `<tr style="color:#64748b;font-size:9.5pt;">
      <td style="${td}padding-left:18pt;">${esc(t.name)}</td>
      <td style="${td}text-align:right;">${fmtQty(t.quantity)}</td>
      <td style="${td}"></td>
    </tr>`
      )
      .join("")}`
      )
      .join("")}
    <tr style="font-weight:bold;">
      <td style="${td}">合计</td>
      <td style="${td}text-align:right;">${fmtQty(quote.totalQuantity)}</td>
      <td style="${td}text-align:right;">${esc(formatMoney(quote.totalAmount, quote.currency))}</td>
    </tr>
  </table>`
      : "";
  const statRow =
    stats && stats.commitCount
      ? `<p style="color:#64748b;font-size:10.5pt;margin:0 0 18pt">
          提交 ${stats.commitCount} 次　·　参与 ${stats.contributorCount ?? "-"} 人　·　代码 +${stats.additions ?? 0}/-${stats.deletions ?? 0}
        </p>`
      : "";

  const items = report.items
    .map(
      (it, i) => `
      <tr>
        <td style="width:28px;vertical-align:top;padding:6pt 0 6pt 0;">
          <span style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:9px;background:#10B981;color:#fff;font-size:9pt;font-weight:bold;">${i + 1}</span>
        </td>
        <td style="vertical-align:top;padding:6pt 0 6pt 6pt;">
          <div style="font-weight:bold;font-size:11.5pt;">
            ${esc(it.title)}
            ${
              it.status === "unverified"
                ? `<span style="font-weight:normal;color:#b45309;font-size:9pt;">（上线后验证效果）</span>`
                : ""
            }
          </div>
          ${it.detail ? `<div style="color:#475569;font-size:10.5pt;margin-top:2pt;">${esc(it.detail)}</div>` : ""}
        </td>
      </tr>`
    )
    .join("");

  const categorySection = details?.categories.length
    ? `${h2("工作明细")}
  ${details.categories
    .map(
      (g) => `<p style="font-weight:bold;margin:10pt 0 4pt;">${esc(CATEGORY_META[g.category].label)}</p>
  <ul style="margin:0;padding-left:16pt;">
    ${g.items
      .map(
        (it) =>
          `<li style="margin:2pt 0;"><b>${esc(it.title)}</b>：${esc(it.description)}<span style="color:#64748b;font-size:9pt;">（${it.commitCount} 个提交）</span></li>`
      )
      .join("")}
  </ul>`
    )
    .join("")}`
    : "";

  const timelineSection = details?.timeline.length
    ? `${h2("按周进展")}
  <table style="font-size:10.5pt;">
    <tr style="background:#f1f5f9;">
      <th style="${td}text-align:left;width:90pt;">周</th>
      <th style="${td}text-align:right;width:50pt;">提交</th>
      <th style="${td}text-align:left;">完成的成果</th>
    </tr>
    ${details.timeline
      .map(
        (w) => `<tr>
      <td style="${td}white-space:nowrap;">${esc(weekLabel(w))}</td>
      <td style="${td}text-align:right;">${w.commitCount}</td>
      <td style="${td}">${esc(w.completed.join("、") || "—")}</td>
    </tr>`
      )
      .join("")}
  </table>`
    : "";

  const riskSection = report.risks?.length
    ? `${h2("风险与待跟进")}
  <ol style="margin:0;padding-left:18pt;color:#475569;">
    ${report.risks.map((r) => `<li style="margin:2pt 0;">${esc(r)}</li>`).join("")}
  </ol>`
    : "";

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${esc(repo ?? "阶段工作汇报")}</title>
<style>
  body { font-family: "微软雅黑", "Microsoft YaHei", sans-serif; font-size: 10.5pt; color: #0f172a; line-height: 1.7; }
  h1 { font-size: 18pt; margin: 0 0 4pt 0; }
  .divider { height: 3px; background: #10B981; width: 48px; margin: 0 0 14pt 0; }
  table { border-collapse: collapse; width: 100%; }
</style>
</head>
<body>
  <h1>${esc(repo ?? "阶段工作汇报")}</h1>
  <div class="divider"></div>
  ${statRow}
  ${report.summary ? `<p style="font-size:11pt;margin:0 0 14pt;">${esc(report.summary)}</p>` : ""}
  <table>${items}</table>
  ${categorySection}
  ${timelineSection}
  ${details?.heatmap && details.heatmap.total > 0 ? heatmapToWordTable(details.heatmap) : ""}
  ${riskSection}
  ${
    report.nextSteps
      ? `<p style="margin-top:18pt;padding-top:10pt;border-top:1px solid #e2e8f0;color:#475569;font-size:10.5pt;">
           <b>后续计划：</b>${esc(report.nextSteps)}
         </p>`
      : ""
  }
  ${quoteTable}
</body>
</html>`;
}

/** 触发浏览器下载 */
export function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob(["﻿", content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}