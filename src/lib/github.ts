import { httpGet, type SimpleResponse } from "./http";

export const DEFAULT_GH_BASE = "https://api.github.com";

/** 本地出口代理（若配置）。生产环境未配置时直接连接。 */
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";

/**
 * 仅使用传入的 token 构造认证头；绝不回退到环境变量，
 * 这样「匿名降级」请求才是真正不带认证的。
 */
function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "commit2value-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// 记录「服务端环境变量 token 已失效」，避免每次请求都先吃一次 401 再降级
let envTokenInvalid = false;

/**
 * 请求 GitHub API。
 * - token 由调用方传入（用户设置里的 PAT），未传时回退到服务端环境变量 GITHUB_TOKEN。
 * - 若实际使用的是「服务端环境变量 token」且返回 401，自动降级为匿名请求并记住失效状态。
 */
export async function ghFetch(
  url: string,
  _init?: unknown,
  token?: string
): Promise<SimpleResponse> {
  const envToken = envTokenInvalid ? undefined : process.env.GITHUB_TOKEN;

  const attempt = (withAuth: boolean): Promise<SimpleResponse> => {
    const t = withAuth ? token || envToken : undefined;
    return httpGet(url, {
      headers: authHeaders(t),
      proxy: PROXY || undefined,
      // 单次请求快速失败，便于证据阶段在时间预算内尽快降级
      timeoutMs: 8000,
    });
  };

  // 用户显式提供的 PAT 优先（用于私有仓库 / GitHub Enterprise）
  if (token) return attempt(true);

  let res = await attempt(true);
  if (res.status === 401 && envToken) {
    envTokenInvalid = true;
    res = await attempt(false);
  }
  return res;
}

export function resolveGhBase(input?: string): string {
  const base = (
    input ||
    process.env.GITHUB_API_BASE_URL ||
    DEFAULT_GH_BASE
  ).trim();
  return base.replace(/\/+$/, "");
}

/**
 * 解析用户输入的仓库地址，支持：
 * - owner/repo
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 */
export function parseRepoInput(
  input: string
): { owner: string; name: string } | null {
  let s = input.trim();
  if (!s) return null;
  s = s
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}
export interface GitHubCommitItem {
  sha: string;
  shortSha: string;
  title: string;
  description: string;
  date: string;
  author: string;
  authorAvatar: string;
}

const COMMITS_PER_PAGE = 50;

/**
 * 拉取单个分支在时间范围内的一页提交。
 * 失败时抛出带 code 的错误（与 gitlabCommits 约定一致），由调用方映射成用户可读信息。
 */
export async function githubCommits(
  base: string,
  owner: string,
  name: string,
  branch: string,
  rangeDays: number,
  page: number,
  token?: string
): Promise<{ commits: GitHubCommitItem[]; hasMore: boolean }> {
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const url = `${base}/repos/${owner}/${name}/commits?sha=${encodeURIComponent(
    branch
  )}&since=${encodeURIComponent(since)}&per_page=${COMMITS_PER_PAGE}&page=${Math.max(1, page)}`;

  const res = await ghFetch(url, undefined, token);
  if (res.status === 404) throw Object.assign(new Error("NOT_FOUND"), { code: 404 });
  if (res.status === 401) throw Object.assign(new Error("UNAUTHORIZED"), { code: 401 });
  if (res.status === 403 || res.status === 429) {
    throw Object.assign(new Error("RATE_LIMITED"), { code: 429 });
  }
  if (!res.ok) throw Object.assign(new Error("UPSTREAM"), { code: 502 });

  type RawCommit = {
    sha?: string;
    commit?: {
      message?: string;
      committer?: { date?: string };
      author?: { date?: string; name?: string };
    };
    author?: { login?: string; avatar_url?: string } | null;
  };
  const raw: unknown = await res.json();
  const list = ((Array.isArray(raw) ? raw : []) as RawCommit[])
    .filter((c) => c?.sha && c.commit?.message)
    .map((c) => {
      const sha = c.sha!;
      const lines = String(c.commit!.message).split("\n").map((l) => l.trim());
      return {
        sha,
        shortSha: sha.slice(0, 7),
        title: lines[0] || "(无标题)",
        description: lines.slice(1).filter(Boolean).join("；").slice(0, 300),
        date: c.commit?.committer?.date || c.commit?.author?.date || "",
        author: c.author?.login || c.commit?.author?.name || "未知",
        authorAvatar: c.author?.avatar_url || "",
      };
    });
  return { commits: list, hasMore: list.length === COMMITS_PER_PAGE };
}
