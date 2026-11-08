import { NextResponse } from "next/server";
import { ghFetch, parseRepoInput, resolveGhBase } from "@/lib/github";
import {
  gitlabRepo,
  parseGitLabProject,
  resolveGitLabBase,
} from "@/lib/gitlab";

export async function POST(req: Request) {
  try {
    const {
      repoInput,
      provider = "github",
      ghBaseUrl,
      ghToken,
      glBaseUrl,
      glToken,
    } = await req.json();
    const input = String(repoInput ?? "");

    // ---------- GitLab ----------
    if (provider === "gitlab") {
      const base = resolveGitLabBase(glBaseUrl);
      const projectId = parseGitLabProject(input);
      if (!projectId) {
        return NextResponse.json(
          { error: "GitLab 项目地址格式不正确，示例：group/project" },
          { status: 400 }
        );
      }
      try {
        const repo = await gitlabRepo(base, projectId, glToken);
        return NextResponse.json({ ...repo, provider: "gitlab" });
      } catch (e: any) {
        const code = e?.code ?? 500;
        const msg =
          e?.message ||
          (code === 404
            ? "找不到该项目，请确认地址，并确认令牌对该私有项目有访问权限"
            : "获取 GitLab 项目失败，请稍后重试");
        return NextResponse.json({ error: msg }, { status: code });
      }
    }

    // ---------- GitHub ----------
    const base = resolveGhBase(ghBaseUrl);
    const parsed = parseRepoInput(input);
    if (!parsed) {
      return NextResponse.json(
        {
          error:
            "仓库地址格式不正确，示例：owner/repo 或 https://github.com/owner/repo",
        },
        { status: 400 }
      );
    }

    const { owner, name } = parsed;
    const repoRes = await ghFetch(
      `${base}/repos/${owner}/${name}`,
      undefined,
      ghToken
    );

    if (repoRes.status === 404) {
      return NextResponse.json(
        {
          error:
            "找不到该仓库，请确认地址、且对私有仓库已填写有访问权限的 PAT",
        },
        { status: 404 }
      );
    }
    if (repoRes.status === 401) {
      return NextResponse.json(
        {
          error:
            "GitHub 请求被拒绝（可能是匿名速率限制或令牌无效）。请稍后重试，或在「设置」中填写有访问权限的 PAT。",
        },
        { status: 401 }
      );
    }
    if (repoRes.status === 403 || repoRes.status === 429) {
      return NextResponse.json(
        {
          error:
            "GitHub API 请求受限。公开仓库请稍后再试；私有仓库请在设置中填写 PAT 以提升限额。",
        },
        { status: 429 }
      );
    }
    if (!repoRes.ok) {
      return NextResponse.json(
        { error: "获取仓库信息失败，请稍后重试" },
        { status: 502 }
      );
    }

    const repo = await repoRes.json();
    const branchesRes = await ghFetch(
      `${base}/repos/${owner}/${name}/branches?per_page=100`,
      undefined,
      ghToken
    );
    const branches: string[] = branchesRes.ok
      ? (await branchesRes.json()).map((b: { name: string }) => b.name)
      : [repo.default_branch];

    return NextResponse.json({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      branches,
      description: repo.description || undefined,
      provider: "github",
    });
  } catch (e) {
    console.error("[repo] exception:", e);
    return NextResponse.json(
      { error: "网络错误，请稍后重试" },
      { status: 500 }
    );
  }
}