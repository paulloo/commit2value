import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";

/**
 * GitHub OAuth 授权码流程（第 1 步）：跳转授权页。
 *
 * 需要配置环境变量：
 *   GITHUB_OAUTH_CLIENT_ID     （GitHub → Settings → Developer settings → OAuth Apps）
 *   GITHUB_OAUTH_CLIENT_SECRET
 *   APP_BASE_URL（可选，默认 http://localhost:4000）
 *
 * 权限范围：repo（私有仓库）+ read:user。生产环境务必校验回调 state 并使用 PKCE。
 */
export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const baseUrl =
    process.env.APP_BASE_URL || new URL(req.url).origin;

  if (!clientId) {
    return NextResponse.json(
      {
        error:
          "未配置 GitHub OAuth。请在服务端设置 GITHUB_OAUTH_CLIENT_ID 与 GITHUB_OAUTH_CLIENT_SECRET，或改用「设置」中的 PAT 方式。",
        code: "OAUTH_NOT_CONFIGURED",
      },
      { status: 501 }
    );
  }

  const state = randomBytes(16).toString("hex");
  const store = await cookies();

  // 保存 state 与 PKCE verifier（httpOnly，防止 CSRF）
  const verifier = randomBytes(32).toString("base64url");
  store.set("c2v_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  store.set("c2v_oauth_verifier", verifier, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${baseUrl}/api/github/oauth/callback`,
    scope: "repo read:user",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(
    `https://github.com/login/oauth/authorize?${params.toString()}`
  );
}