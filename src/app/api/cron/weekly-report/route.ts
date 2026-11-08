import { ghFetch, resolveGhBase } from "@/lib/github";
import { enrichWithEvidence, summarizeScope } from "@/lib/evidence";
import type { CommitItem } from "@/lib/types";

/**
 * 自动化：供 GitHub Actions / 定时任务调用的周报生成入口。
 * 认证完全来自服务端环境变量 GITHUB_TOKEN，不依赖浏览器。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const repo = String(body.repo || process.env.C2V_REPO || "");
    const days = Math.min(Math.max(Number(body.days) || 7, 1), 90);
    const base = resolveGhBase(body.ghBaseUrl);

    if (!repo) {
      return Response.json(
        { error: "缺少 repo 参数（形如 owner/repo）" },
        { status: 400 }
      );
    }

    const [owner, name] = repo.split("/");
    if (!owner || !name) {
      return Response.json(
        { error: "repo 格式应为 owner/repo" },
        { status: 400 }
      );
    }

    // 1) 默认分支
    const repoRes = await ghFetch(`${base}/repos/${owner}/${name}`, undefined);
    if (!repoRes.ok) {
      return Response.json(
        { error: `无法读取仓库（${repoRes.status}），请检查 GITHUB_TOKEN 权限` },
        { status: repoRes.status }
      );
    }
    const repoInfo: any = await repoRes.json();
    const branch = body.branch || repoInfo.default_branch;

    // 2) 提交
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const commitsRes = await ghFetch(
      `${base}/repos/${owner}/${name}/commits?sha=${encodeURIComponent(
        branch
      )}&since=${encodeURIComponent(since)}&per_page=100`,
      undefined
    );
    if (!commitsRes.ok) {
      return Response.json(
        { error: `无法读取提交（${commitsRes.status}）` },
        { status: commitsRes.status }
      );
    }
    const raw: any[] = await commitsRes.json();
    const commits: CommitItem[] = (Array.isArray(raw) ? raw : []).map((c) => {
      const lines = String(c.commit.message).split("\n").map((l) => l.trim());
      return {
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        title: lines[0],
        description: lines.slice(1).filter(Boolean).join("；").slice(0, 300),
        date: c.commit.committer?.date || c.commit.author?.date,
        author: c.author?.login || c.commit.author?.name || "未知",
      };
    });

    if (!commits.length) {
      return Response.json({ repo, days, achievements: [], report: null });
    }

    // 3) 代码证据（可选，失败不阻断）
    let evidenceMap = new Map<string, any>();
    try {
      evidenceMap = await enrichWithEvidence(base, owner, name, commits);
    } catch {
      /* 降级 */
    }

    // 4) 调AI 生成报告
    const apiKey = process.env.OPENAI_API_KEY || "";
    const baseUrl = (
      process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!apiKey) {
      return Response.json(
        { error: "未配置 OPENAI_API_KEY，无法生成周报" },
        { status: 400 }
      );
    }

    const validShas = new Set(commits.map((c) => c.shortSha));
    const lines = commits
      .map((c, i) => {
        const ev = evidenceMap.get(c.sha);
        const date = new Date(c.date).toISOString().slice(0, 10);
        const extra = ev
          ? `\n   代码证据：${ev.changedFiles} 个文件，+${ev.additions}/-${ev.deletions} 行；主要文件：${ev.filePaths
              .slice(0, 5)
              .join(", ")}${summarizeScope(ev.filePaths) ? `\n   ${summarizeScope(ev.filePaths)}` : ""}`
          : "";
        return `${i + 1}. [${c.shortSha}] ${date} 作者：${c.author}\n   标题：${c.title}${
          c.description ? `\n   详情：${c.description}` : ""
        }${extra}`;
      })
      .join("\n");

    const ai = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是资深技术PM。把提交翻译成客户成果。禁止编造指标。只用给定哈希。报告用中文纯文本，不用 Markdown 符号。输出 JSON：{\"achievements\":[{\"title\":\"\",\"description\":\"\",\"value\":\"\",\"shas\":[\"\"],\"status\":\"evidenced|unverified\"}],\"report\":{\"summary\":\"\",\"items\":[{\"title\":\"\",\"detail\":\"\"}],\"nextSteps\":\"\"}}",
          },
          { role: "user", content: `仓库：${repo}\n分支：${branch}\n提交：\n${lines}` },
        ],
      }),
    });
    const aiData: any = await ai.json();
    const parsed = JSON.parse(aiData?.choices?.[0]?.message?.content ?? "{}");

    const achievements = (parsed.achievements ?? [])
      .filter((a: any) => a && a.title)
      .map((a: any) => ({
        ...a,
        shas: (a.shas ?? []).filter((s: string) => validShas.has(s)),
      }));

    return Response.json({
      repo,
      branch,
      days,
      from: since,
      to: new Date().toISOString(),
      commitCount: commits.length,
      achievements,
      report: parsed.report ?? null,
      stats: {
        additions: [...evidenceMap.values()].reduce((s: number, e: any) => s + e.additions, 0),
        deletions: [...evidenceMap.values()].reduce((s: number, e: any) => s + e.deletions, 0),
      },
    });
  } catch (e) {
    console.error("[cron] exception:", e);
    return Response.json({ error: "生成失败" }, { status: 500 });
  }
}