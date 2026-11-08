import { NextResponse } from "next/server";
import { githubCommits, resolveGhBase } from "@/lib/github";
import {
  gitlabCommits,
  parseGitLabProject,
  resolveGitLabBase,
} from "@/lib/gitlab";
import { MAX_BRANCHES } from "@/lib/limits";
import type { CommitItem } from "@/lib/types";

/** 分支并发数：多分支时控制瞬时请求量，避免触发二级速率限制 */
const BRANCH_CONCURRENCY = 4;

type Fetched = { commits: Omit<CommitItem, "branches">[]; hasMore: boolean };

function errorMessage(provider: string, code: number): string {
  const gh = provider !== "gitlab";
  switch (code) {
    case 404:
      return gh ? "分支不存在或仓库不可访问" : "分支不存在或项目不可访问";
    case 401:
      return gh
        ? "GitHub 请求被拒绝（令牌无效或权限不足）。请在「设置」中确认访问令牌是否有效且已勾选该仓库的 Contents 读取权限。"
        : "GitLab 请求被拒绝。请在「设置」中填写有 read_api 权限的 Personal Access Token。";
    case 429:
      return gh
        ? "GitHub API 请求受限。公开仓库请稍后再试；私有仓库请在设置中填写 PAT 以提升限额。"
        : "GitLab API 请求受限，请稍后再试。";
    default:
      return gh ? "获取提交列表失败，请稍后重试" : "获取 GitLab 提交失败，请稍后重试";
  }
}

/**
 * 拉取一个或多个分支的提交，按 SHA 去重合并。
 *
 * 请求体：
 * - branches: 要拉取的分支（首屏，均从第 1 页开始）；兼容旧字段 branch
 * - pages:    { 分支: 页码 }，用于「加载更多」，只拉仍有下一页的分支
 *
 * 响应：commits（按时间倒序，带 branches 字段）、cursors（各分支下一页页码，null 表示已到底）、
 * warnings（部分分支失败时的提示；全部失败才返回错误）。
 */
export async function POST(req: Request) {
  try {
    const {
      owner,
      name,
      branch,
      branches,
      pages,
      rangeDays = 7,
      provider = "github",
      ghBaseUrl,
      ghToken,
      glBaseUrl,
      glToken,
    } = await req.json();

    const days = Math.min(Math.max(Number(rangeDays) || 7, 1), 90);

    // 归一化为 [分支, 页码] 列表
    let targets: Array<[string, number]>;
    if (pages && typeof pages === "object" && !Array.isArray(pages)) {
      targets = Object.entries(pages as Record<string, unknown>).map(
        ([b, p]) => [b, Math.max(1, Number(p) || 1)]
      );
    } else {
      const list: string[] =
        Array.isArray(branches) && branches.length
          ? branches.map(String)
          : branch
            ? [String(branch)]
            : [];
      targets = [...new Set(list)].map((b) => [b, 1]);
    }
    targets = targets.filter(([b]) => b.trim());

    if (targets.length === 0) {
      return NextResponse.json({ error: "缺少分支参数" }, { status: 400 });
    }
    if (targets.length > MAX_BRANCHES) {
      return NextResponse.json(
        { error: `一次最多读取 ${MAX_BRANCHES} 个分支，请减少选择的分支` },
        { status: 400 }
      );
    }

    let fetchOne: (branch: string, page: number) => Promise<Fetched>;
    if (provider === "gitlab") {
      // owner 对 GitLab 而言是完整命名空间（可含子组），与 name 拼接即项目路径
      const projectId = owner && name ? `${owner}/${name}` : "";
      const parsedId = projectId || parseGitLabProject(String(owner ?? ""));
      if (!parsedId) {
        return NextResponse.json({ error: "缺少 GitLab 项目参数" }, { status: 400 });
      }
      const base = resolveGitLabBase(glBaseUrl);
      fetchOne = (b, p) => gitlabCommits(base, parsedId, b, days, p, glToken);
    } else {
      if (!owner || !name) {
        return NextResponse.json({ error: "缺少仓库参数" }, { status: 400 });
      }
      const base = resolveGhBase(ghBaseUrl);
      fetchOne = (b, p) => githubCommits(base, owner, name, b, days, p, ghToken);
    }

    // ---- 受控并发拉取各分支 ----
    const results: Array<
      | { branch: string; page: number; ok: true; data: Fetched }
      | { branch: string; ok: false; code: number }
    > = [];
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const [b, p] = targets[cursor++];
        try {
          results.push({ branch: b, page: p, ok: true, data: await fetchOne(b, p) });
        } catch (e) {
          const code = Number((e as { code?: unknown } | null)?.code) || 500;
          results.push({ branch: b, ok: false, code });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(BRANCH_CONCURRENCY, targets.length) }, worker)
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length === results.length) {
      const first = failures[0] as { code: number };
      const status = [400, 401, 404, 429].includes(first.code) ? first.code : 502;
      return NextResponse.json(
        { error: errorMessage(provider, first.code) },
        { status }
      );
    }

    // ---- 按 SHA 合并，记录所属分支 ----
    const merged = new Map<string, CommitItem>();
    const cursors: Record<string, number | null> = {};
    for (const r of results) {
      if (!r.ok) {
        cursors[r.branch] = null;
        continue;
      }
      cursors[r.branch] = r.data.hasMore ? r.page + 1 : null;
      for (const c of r.data.commits) {
        const existing = merged.get(c.sha);
        if (existing) {
          if (!existing.branches!.includes(r.branch)) existing.branches!.push(r.branch);
        } else {
          merged.set(c.sha, { ...c, branches: [r.branch] });
        }
      }
    }
    const commits = [...merged.values()].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );

    const warnings = failures.map(
      (f) =>
        `分支「${f.branch}」读取失败：${errorMessage(provider, (f as { code: number }).code)}`
    );

    return NextResponse.json({
      commits,
      cursors,
      hasMore: Object.values(cursors).some((p) => p !== null),
      rangeDays: days,
      warnings,
    });
  } catch (e) {
    console.error("[commits] exception:", e);
    return NextResponse.json(
      { error: "网络错误，请稍后重试" },
      { status: 500 }
    );
  }
}
