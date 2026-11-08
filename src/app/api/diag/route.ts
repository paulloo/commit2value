import { NextResponse } from "next/server";

/**
 * 线上环境诊断：分别探测 GitHub / AI 服务 / DNS 的连通性与耗时。
 * 用于区分"网络不可达"与"响应过慢"两类问题。
 */
export async function GET() {
  const results: Record<string, unknown> = {};
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  results.proxy = proxy ? "已配置" : "未配置（直连）";

  // 1) DNS + TCP 探测 GitHub
  const t0 = Date.now();
  try {
    const dns = await import("node:dns/promises");
    await dns.lookup("api.github.com");
    results.dnsMs = Date.now() - t0;
    results.dns = "正常";
  } catch (e: any) {
    results.dns = `失败：${e?.message ?? e}`;
    results.dnsMs = Date.now() - t0;
  }

  // 2) 实际请求 GitHub API
  const t1 = Date.now();
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: {
        "User-Agent": "commit2value-diag",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8000),
    });
    results.githubStatus = res.status;
    results.githubMs = Date.now() - t1;
  } catch (e: any) {
    results.githubStatus = "失败";
    results.githubError = e?.message ?? String(e);
    results.githubMs = Date.now() - t1;
  }

  // 3) 探测常见 AI 端点（仅探测可达性，不发送密钥）
  for (const host of ["api.openai.com", "api.deepseek.com"]) {
    const t = Date.now();
    try {
      await fetch(`https://${host}/v1/models`, {
        signal: AbortSignal.timeout(6000),
      }).catch(() => null);
      results[`ai_${host}`] = `可达（${Date.now() - t}ms）`;
    } catch (e: any) {
      results[`ai_${host}`] = `不可达：${e?.message ?? e}`;
    }
  }

  results.node = process.version;
  return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
}