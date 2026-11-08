import { NextResponse } from "next/server";
import { resolveGhBase } from "@/lib/github";
import { resolveGitLabBase } from "@/lib/gitlab";
import { fetchProjectContext } from "@/lib/project-docs";

/**
 * 读取仓库关键文档作为项目背景。
 * 分析开始前由前端调用一次，结果复用到每个分析批次、合并与估时，避免重复请求代码平台。
 * 任何失败都返回空背景（200），不阻断分析。
 */
export async function POST(req: Request) {
  try {
    const {
      owner,
      name,
      ref,
      settings,
    }: {
      owner?: string;
      name?: string;
      ref?: string;
      settings?: {
        provider?: "github" | "gitlab";
        ghBaseUrl?: string;
        ghToken?: string;
        glBaseUrl?: string;
        glToken?: string;
      };
    } = await req.json();

    if (!owner || !name || !ref) {
      return NextResponse.json({ text: "", sources: [] });
    }
    const gitlab = settings?.provider === "gitlab";
    const context = await fetchProjectContext({
      provider: gitlab ? "gitlab" : "github",
      base: gitlab
        ? resolveGitLabBase(settings?.glBaseUrl)
        : resolveGhBase(settings?.ghBaseUrl),
      owner,
      name,
      ref,
      token: gitlab ? settings?.glToken : settings?.ghToken,
    });
    return NextResponse.json(context);
  } catch (e) {
    console.error("[project-context] degrade to empty:", e);
    return NextResponse.json({ text: "", sources: [] });
  }
}
