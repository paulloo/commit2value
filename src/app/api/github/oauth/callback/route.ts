import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { httpGet, httpPost } from "@/lib/http";

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";

/** 用授权码 + PKCE 换取访问令牌 */
async function exchangeToken(code: string, verifier: string) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET!;
  const base = process.env.APP_BASE_URL || "http://localhost:4000";

  const r = await httpPost(
    "https://github.com/login/oauth/access_token",
    JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${base}/api/github/oauth/callback`,
      code_verifier: verifier,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "commit2value-app",
      },
    }
  );
  const j: any = await r.json().catch(() => ({}));
  return j.access_token as string | undefined;
}

/** GitHub OAuth 第 2 步：校验 state → 换 token → 探测一个可访问仓库 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();

  const savedState = store.get("c2v_oauth_state")?.value;
  const verifier = store.get("c2v_oauth_verifier")?.value;
  store.delete("c2v_oauth_state");
  store.delete("c2v_oauth_verifier");

  if (!code || !state || !savedState || state !== savedState) {
    return NextResponse.json(
      { error: "OAuth 校验失败，请重试或改用 PAT 方式" },
      { status: 400 }
    );
  }

  const token = verifier ? await exchangeToken(code, verifier) : undefined;
  if (!token) {
    return NextResponse.json(
      { error: "获取访问令牌失败，请检查 OAuth App 配置或改用 PAT 方式" },
      { status: 502 }
    );
  }

  // 探测可访问的仓库（token 不返回前端、不落 localStorage）
  const r = await httpGet(
    "https://api.github.com/user/repos?per_page=100&sort=updated",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "commit2value-app",
      },
      proxy: PROXY || undefined,
    }
  );
  const data: any = r.ok ? await r.json().catch(() => []) : [];
  const repoList: any[] = Array.isArray(data) ? data : [];

  return NextResponse.json(
    {
      type: "c2v-oauth-result",
      ok: true,
      repoCount: repoList.length,
      sample: repoList.slice(0, 30).map((x) => ({
        fullName: x.full_name,
        private: x.private,
        defaultBranch: x.default_branch,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}