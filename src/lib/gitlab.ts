import { httpGet, type SimpleResponse } from "./http";
import { buildDiffExcerpt } from "./diff";

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";

export const DEFAULT_GITLAB_BASE = "https://gitlab.com/api/v4";

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": "commit2value-app" };
  if (token) h["PRIVATE-TOKEN"] = token;
  return h;
}

async function glFetch(
  url: string,
  token?: string
): Promise<{ status: number; ok: boolean; json: () => Promise<any> }> {
  return httpGet(url, { headers: headers(token), proxy: PROXY || undefined });
}

/** 带超时的 GitLab GET，供需要原始文本（如仓库文件）的调用方使用 */
export function glGet(url: string, token?: string, timeoutMs = 8000): Promise<SimpleResponse> {
  return httpGet(url, { headers: headers(token), proxy: PROXY || undefined, timeoutMs });
}

export function resolveGitLabBase(input?: string): string {
  const base = (input || process.env.GITLAB_API_BASE_URL || DEFAULT_GITLAB_BASE).trim();
  return base.replace(/\/+$/, "");
}

/**
 * 解析仓库输入，支持：
 * - group/project 或 group/subgroup/project（GitLab 允许嵌套子组）
 * - https://gitlab.com/group/project
 * - 自托管 https://gitlab.your.com/group/project
 */
export function parseGitLabProject(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  // 仅当输入含 host（含点或 localhost）时才剥离第一段，
  // 否则 "group/project" 会被误伤。
  if (/^[^/]+\.[^/]+\//.test(s)) {
    s = s.replace(/^[^/]+\//, "");
  }
  s = s.replace(/\/-\/.*$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map(encodeURIComponent).join("/");
}

export interface GitLabRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  branches: string[];
  description?: string;
}

export async function gitlabRepo(
  base: string,
  projectId: string,
  token?: string
): Promise<GitLabRepo> {
  const enc = encodeURIComponent(projectId);
  const repoRes = await glFetch(`${base}/projects/${enc}`, token);
  if (repoRes.status === 404) {
    throw Object.assign(new Error("NOT_FOUND"), { code: 404 });
  }
  if (repoRes.status === 401 || repoRes.status === 403) {
    throw Object.assign(new Error("UNAUTHORIZED"), {
      code: 401,
      message:
        "GitLab 请求被拒绝。请在「设置」中填写有 read_api 权限的 Personal Access Token，并确认该私有项目已授权给该令牌。",
    });
  }
  if (repoRes.status === 429) {
    throw Object.assign(new Error("RATE_LIMITED"), { code: 429 });
  }
  if (!repoRes.ok) {
    throw Object.assign(new Error("UPSTREAM"), { code: 502 });
  }
  const repo = await repoRes.json();

  const branchesRes = await glFetch(
    `${base}/projects/${enc}/repository/branches?per_page=100`,
    token
  );
  const branches: string[] = branchesRes.ok
    ? (await branchesRes.json()).map((b: any) => b.name)
    : [repo.default_branch];

  const path = repo.path_with_namespace || projectId;
  return {
    owner: path.split("/").slice(0, -1).join("/"),
    name: repo.name || path.split("/").pop(),
    fullName: path,
    defaultBranch: repo.default_branch,
    branches: branches.length ? branches : [repo.default_branch],
    description: repo.description || undefined,
  };
}

export interface GitLabCommitItem {
  sha: string;
  shortSha: string;
  title: string;
  description: string;
  date: string;
  author: string;
  authorAvatar: string;
}

export async function gitlabCommits(
  base: string,
  projectId: string,
  branch: string,
  rangeDays: number,
  page: number,
  token?: string
): Promise<{ commits: GitLabCommitItem[]; hasMore: boolean }> {
  const enc = encodeURIComponent(projectId);
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const url =
    `${base}/projects/${enc}/repository/commits` +
    `?ref_name=${encodeURIComponent(branch)}` +
    `&since=${encodeURIComponent(since)}&per_page=50&page=${Math.max(1, page)}`;

  const res = await glFetch(url, token);
  if (res.status === 404) {
    throw Object.assign(new Error("NOT_FOUND"), { code: 404 });
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("UNAUTHORIZED"), { code: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error("UPSTREAM"), { code: 502 });
  }
  const raw = await res.json();
  const list = (Array.isArray(raw) ? raw : []).map((c: any) => {
    const message: string = c.message || "";
    const lines = message.split("\n").map((l: string) => l.trim());
    return {
      // GitLab 返回的是短 id，这里补齐为可比较的短哈希
      sha: c.id,
      shortSha: String(c.id).slice(0, 8),
      title: lines[0] || "(无标题)",
      description: lines.slice(1).filter(Boolean).join("；").slice(0, 300),
      date: c.committed_date || c.authored_date,
      author: c.author_name || "未知",
      authorAvatar: c.author_email || "",
    };
  });
  return { commits: list, hasMore: list.length === 50 };
}

/** 拉取单个提交的文件变更统计（用于代码证据） */
export async function gitlabCommitEvidence(
  base: string,
  projectId: string,
  sha: string,
  token?: string
) {
  const enc = encodeURIComponent(projectId);
  const res = await glFetch(
    `${base}/projects/${enc}/repository/commits/${encodeURIComponent(sha)}/diff`,
    token
  );
  if (!res.ok) return null;
  const data: unknown = await res.json();
  const files = (Array.isArray(data) ? data : []) as Array<{
    new_path?: string;
    old_path?: string;
    diff?: string;
  }>;
  const paths = files
    .map((f) => f?.new_path || f?.old_path)
    .filter(Boolean)
    .slice(0, 12) as string[];
  return {
    changedFiles: files.length,
    filePaths: paths,
    diffExcerpt: buildDiffExcerpt(
      files.map((f) => ({
        path: String(f?.new_path || f?.old_path || ""),
        patch: typeof f?.diff === "string" ? f.diff : undefined,
      }))
    ),
  };
}