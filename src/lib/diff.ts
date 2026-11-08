/**
 * 从提交的 diff 中提取给模型看的「改动摘录」。
 *
 * 目标是在固定字符预算内让模型看到实际改了什么：
 * - 跳过 lock 文件、构建产物、压缩/生成代码、二进制资源（它们的行数不代表工作量）
 * - 按改动量从大到小挑文件，每个文件有单独上限，避免一个大文件吃光预算
 * - 只保留 hunk 头（git 会在其中带上函数/类名）和增删行，丢弃上下文行与缩进
 */

const NOISE_PATTERNS = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|Podfile\.lock|pubspec\.lock)$/i,
  /\.min\.(js|css)$/i,
  /\.(map|snap)$/i,
  /(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage|__generated__|generated)\//i,
  /\.generated\.|\.pb\.go$|_pb2\.py$/i,
  /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tar|woff2?|ttf|otf|eot|mp3|mp4|mov|wav)$/i,
];

export function isNoiseFile(path: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(path));
}

/** 单个提交的摘录预算（字符） */
export const DIFF_EXCERPT_BUDGET = 1500;
const PER_FILE_BUDGET = 600;
const MAX_LINE = 160;

export interface DiffFile {
  path: string;
  /** unified diff 文本（GitHub 的 patch / GitLab 的 diff），二进制或超大文件可能缺失 */
  patch?: string;
  /** 增删行数之和，缺省时按 patch 统计 */
  changes?: number;
}

function changedLines(patch: string): number {
  let n = 0;
  for (const l of patch.split("\n")) {
    if ((l[0] === "+" || l[0] === "-") && !l.startsWith("+++") && !l.startsWith("---")) n++;
  }
  return n;
}

function compactFile(path: string, patch: string, budget: number): string {
  const out: string[] = [`# ${path}`];
  let used = out[0].length;
  for (const raw of patch.split("\n")) {
    let line: string;
    if (raw.startsWith("@@")) {
      line = raw.trim();
    } else if (
      (raw[0] === "+" || raw[0] === "-") &&
      !raw.startsWith("+++") &&
      !raw.startsWith("---")
    ) {
      const body = raw.slice(1).trim();
      if (!body) continue;
      line = raw[0] + body;
    } else {
      continue;
    }
    line = line.slice(0, MAX_LINE);
    if (used + line.length + 1 > budget) {
      out.push("…");
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.length > 1 ? out.join("\n") : "";
}

export function buildDiffExcerpt(
  files: DiffFile[],
  budget = DIFF_EXCERPT_BUDGET
): string {
  const candidates = files
    .filter((f) => f.path && f.patch && !isNoiseFile(f.path))
    .map((f) => ({ ...f, weight: f.changes ?? changedLines(f.patch!) }))
    .sort((a, b) => b.weight - a.weight);

  const parts: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const f of candidates) {
    const remaining = budget - used;
    if (remaining < 120) {
      skipped++;
      continue;
    }
    const block = compactFile(f.path, f.patch!, Math.min(PER_FILE_BUDGET, remaining));
    if (!block) continue;
    parts.push(block);
    used += block.length + 1;
  }
  if (skipped) parts.push(`…（另有 ${skipped} 个文件的改动未展示）`);
  return parts.join("\n");
}
