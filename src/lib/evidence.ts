import { ghFetch, resolveGhBase } from "@/lib/github";
import type { CommitEvidence } from "@/lib/types";
import { ANALYZE_BATCH_SIZE } from "@/lib/limits";
import { buildDiffExcerpt } from "@/lib/diff";

/**
 * 并发受控地补全每个提交的代码证据（增删行数 / 变更文件 / 关联 PR）。
 *
 * 线上对整体响应时间敏感（网关有超时阈值），因此这里设置**硬性时间预算**：
 * 一旦超过budgetMs 立刻放弃剩余请求，用已拿到的证据继续走AI，
 * 保证"证据不完整"不会导致整个分析超时失败。
 */
async function enrichWithEvidence(
  base: string,
  owner: string,
  name: string,
  commits: Array<{ sha: string }>,
  token?: string,
  budgetMs = 6000
): Promise<Map<string, CommitEvidence>> {
  const out = new Map<string, CommitEvidence>();
  // 控制并发，避免触发二级速率限制；数量上限防止请求过多
  const targets = commits.slice(0, ANALYZE_BATCH_SIZE);
  const CONCURRENCY = 10;

  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  let stopped = false;

  async function worker() {
    while (cursor < targets.length) {
      // 超预算即停止派发新任务
      if (Date.now() > deadline || stopped) return;
      const item = targets[cursor++];
      try {
        // 单请求 8s 超时，避免单个卡住拖垮整体
        const res = await ghFetch(
          `${base}/repos/${owner}/${name}/commits/${item.sha}`,
          undefined,
          token
        );
        if (!res.ok) continue;
        const d: any = await res.json();
        const files: any[] = Array.isArray(d.files) ? d.files : [];
        out.set(item.sha, {
          sha: item.sha,
          additions: Number(d.stats?.additions) || 0,
          deletions: Number(d.stats?.deletions) || 0,
          changedFiles: files.length,
          // 只保留有信息量的路径，且限制数量
          filePaths: files
            .map((f: any) => f?.filename)
            .filter(Boolean)
            .slice(0, 12) as string[],
          prNumbers: Array.isArray(d.pull_requests)
            ? d.pull_requests
                .map((p: any) => p?.number)
                .filter(Boolean)
            : [],
          // GitHub 的提交详情本身就带每个文件的 patch，无需额外请求
          diffExcerpt: buildDiffExcerpt(
            files.map((f: { filename?: string; patch?: unknown; changes?: unknown }) => ({
              path: String(f?.filename ?? ""),
              patch: typeof f?.patch === "string" ? f.patch : undefined,
              changes: Number(f?.changes) || undefined,
            }))
          ),
        });
      } catch {
        // 单个提交失败不影响整体
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () =>
      worker()
    )
  );
  return out;
}

/**
 * 带硬性上限的证据补全。
 *
 * 底层请求若卡在 DNS 解析或TCP 建连（socket 超时无法覆盖），
 * Promise.all 可能长时间不返回，进而拖垮整个分析请求（线上表现为 524）。
 * 因此这里用 Promise.race 强制兜底：超时立即返回已拿到的部分，
 * 让调用方继续走 AI，绝不无限等待。
 */
export async function enrichWithEvidenceSafe(
  base: string,
  owner: string,
  name: string,
  commits: Array<{ sha: string }>,
  token?: string,
  budgetMs = 6000
): Promise<Map<string, CommitEvidence>> {
  try {
    return await Promise.race([
      enrichWithEvidence(base, owner, name, commits, token, budgetMs),
      new Promise<Map<string, CommitEvidence>>((resolve) =>
        setTimeout(() => resolve(new Map()), budgetMs + 500)
      ),
    ]);
  } catch {
    return new Map();
  }
}

/** 把文件路径归纳成人类可读的「改动范围」描述 */
function summarizeScope(files: string[]): string {
  if (!files.length) return "";
  const ext = new Map<string, number>();
  const dirs = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts[0] : "根目录";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    const m = f.match(/\.([a-z0-9]+)$/i);
    const e = (m ? m[1] : "其他").toLowerCase();
    ext.set(e, (ext.get(e) ?? 0) + 1);
  }
  const topDirs = [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d, n]) => `${d}(${n}个文件)`)
    .join("、");
  const topExt = [...ext.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([e, n]) => `.${e}×${n}`)
    .join(" ");
  return `改动集中在 ${topDirs}${topExt ? `；主要文件类型 ${topExt}` : ""}`;
}

export { enrichWithEvidence, summarizeScope };