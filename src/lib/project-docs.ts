import { ghFetch } from "@/lib/github";
import { glGet } from "@/lib/gitlab";
import type { ProjectContext } from "@/lib/types";

/**
 * 读取仓库中说明业务与结构的关键文档，拼成给模型的「项目背景」。
 *
 * 只读分支最新版本的少量文件：README、docs/ 下的若干 Markdown、AGENTS/CLAUDE.md、
 * CHANGELOG 开头与 package.json 摘要。整体有时间预算，超时返回已读到的部分，
 * 读取失败返回空背景，绝不阻断分析。
 */

export const MAX_CONTEXT_CHARS = 6000;
const BUDGET_MS = 5000;
const MAX_FILE_BYTES = 200_000;
const MAX_DOCS_FILES = 3;

type Entry = { path: string; name: string; type: "file" | "dir"; size?: number };

interface Source {
  list(dir: string): Promise<Entry[]>;
  read(path: string): Promise<string | null>;
}

function githubSource(base: string, owner: string, name: string, ref: string, token?: string): Source {
  const root = `${base}/repos/${owner}/${name}/contents`;
  const q = `ref=${encodeURIComponent(ref)}`;
  const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  return {
    async list(dir) {
      const res = await ghFetch(`${root}${dir ? "/" + encPath(dir) : ""}?${q}`, undefined, token);
      if (!res.ok) return [];
      const data: unknown = await res.json();
      return (Array.isArray(data) ? data : []).map((e: { path?: string; name?: string; type?: string; size?: number }) => ({
        path: String(e?.path ?? ""),
        name: String(e?.name ?? ""),
        type: e?.type === "dir" ? "dir" : "file",
        size: Number(e?.size) || 0,
      }));
    },
    async read(path) {
      const res = await ghFetch(`${root}/${encPath(path)}?${q}`, undefined, token);
      if (!res.ok) return null;
      const d = (await res.json()) as { content?: string; encoding?: string };
      if (typeof d?.content !== "string" || d.encoding !== "base64") return null;
      return Buffer.from(d.content, "base64").toString("utf8");
    },
  };
}

function gitlabSource(base: string, projectId: string, ref: string, token?: string): Source {
  const proj = `${base}/projects/${encodeURIComponent(projectId)}/repository`;
  const q = `ref=${encodeURIComponent(ref)}`;
  return {
    async list(dir) {
      const res = await glGet(
        `${proj}/tree?${q}&per_page=100${dir ? `&path=${encodeURIComponent(dir)}` : ""}`,
        token,
        BUDGET_MS
      );
      if (!res.ok) return [];
      const data: unknown = await res.json();
      return (Array.isArray(data) ? data : []).map((e: { path?: string; name?: string; type?: string }) => ({
        path: String(e?.path ?? ""),
        name: String(e?.name ?? ""),
        type: e?.type === "tree" ? "dir" : "file",
      }));
    },
    async read(path) {
      const res = await glGet(
        `${proj}/files/${encodeURIComponent(path)}/raw?${q}`,
        token,
        BUDGET_MS
      );
      return res.ok ? res.text() : null;
    },
  };
}

/** 去掉对模型无用、又很占篇幅的 Markdown 成分 */
function cleanMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    // 徽章与图片（行内式与引用式）
    .replace(/\[!\[[^\]]*\](\([^)]*\)|\[[^\]]*\])\](\([^)]*\)|\[[^\]]*\])/g, "")
    .replace(/!\[[^\]]*\](\([^)]*\)|\[[^\]]*\])/g, "")
    // 链接只留文字
    .replace(/\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => l.trim())
    // 引用式链接定义（[id]: url）
    .filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l))
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join("\n")
    .trim();
}

function summarizePackageJson(raw: string): string {
  try {
    const p = JSON.parse(raw) as {
      name?: string;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(p.dependencies ?? {}).slice(0, 25);
    return [
      p.name && `名称：${p.name}`,
      p.description && `描述：${p.description}`,
      deps.length && `主要依赖：${deps.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

type Pick = { path: string; limit: number; kind: "md" | "pkg" };

const DOC_PRIORITY = /(overview|intro|architecture|design|product|prd|spec|guide|readme|业务|产品|架构|设计)/i;

function choose(rootEntries: Entry[], docsEntries: Entry[]): Pick[] {
  const files = rootEntries.filter((e) => e.type === "file" && (e.size ?? 0) <= MAX_FILE_BYTES);
  const find = (re: RegExp) => files.find((e) => re.test(e.name));
  const picks: Pick[] = [];
  const readme = find(/^readme(\.(md|markdown|rst|txt))?$/i);
  if (readme) picks.push({ path: readme.path, limit: 2500, kind: "md" });
  const pkg = find(/^package\.json$/);
  if (pkg) picks.push({ path: pkg.path, limit: 400, kind: "pkg" });
  const docs = docsEntries
    .filter((e) => e.type === "file" && /\.(md|markdown)$/i.test(e.name) && (e.size ?? 0) <= MAX_FILE_BYTES)
    .sort(
      (a, b) =>
        Number(DOC_PRIORITY.test(b.name)) - Number(DOC_PRIORITY.test(a.name)) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, MAX_DOCS_FILES);
  for (const d of docs) picks.push({ path: d.path, limit: 1000, kind: "md" });
  for (const e of files.filter((f) => /^(agents|claude)\.md$/i.test(f.name))) {
    picks.push({ path: e.path, limit: 1200, kind: "md" });
  }
  const changelog = find(/^(changelog|changes|history)(\.(md|markdown|txt))?$/i);
  if (changelog) picks.push({ path: changelog.path, limit: 1000, kind: "md" });
  return picks;
}

async function collect(src: Source, out: Map<string, string>): Promise<Pick[]> {
  const root = await src.list("");
  const docsDir = root.find((e) => e.type === "dir" && /^docs?$/i.test(e.name));
  const docsEntries = docsDir ? await src.list(docsDir.path) : [];
  const picks = choose(root, docsEntries);
  await Promise.all(
    picks.map(async (p) => {
      try {
        const raw = await src.read(p.path);
        if (!raw) return;
        const text = (p.kind === "pkg" ? summarizePackageJson(raw) : cleanMarkdown(raw)).slice(0, p.limit);
        if (text) out.set(p.path, text);
      } catch {
        // 单个文件失败不影响其余
      }
    })
  );
  return picks;
}

export async function fetchProjectContext(opts: {
  provider: "github" | "gitlab";
  base: string;
  owner: string;
  name: string;
  ref: string;
  token?: string;
}): Promise<ProjectContext> {
  const src =
    opts.provider === "gitlab"
      ? gitlabSource(opts.base, `${opts.owner}/${opts.name}`, opts.ref, opts.token)
      : githubSource(opts.base, opts.owner, opts.name, opts.ref, opts.token);

  // 读到的内容先进 out，超时后用已读到的部分组装
  const out = new Map<string, string>();
  let order: Pick[] = [];
  await Promise.race([
    collect(src, out).then((p) => (order = p)).catch(() => undefined),
    new Promise((r) => setTimeout(r, BUDGET_MS)),
  ]);

  // 预算超时时 order 可能尚未返回，按读取先后兜底
  const paths = order.length ? order.map((p) => p.path).filter((p) => out.has(p)) : [...out.keys()];
  const blocks: string[] = [];
  const sources: string[] = [];
  let used = 0;
  for (const path of paths) {
    const block = `【${path}】\n${out.get(path)}`;
    // 放不下就跳过，后面更短的文件（如 package.json 摘要）可能还放得下
    if (used + block.length > MAX_CONTEXT_CHARS) continue;
    blocks.push(block);
    sources.push(path);
    used += block.length + 2;
  }
  return { text: blocks.join("\n\n"), sources };
}
