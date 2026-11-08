import { splitBatches } from "@/lib/analyze-client";
import { ESTIMATE_BATCH_CONCURRENCY, ESTIMATE_BATCH_SIZE } from "@/lib/limits";
import type {
  Achievement,
  CommitEvidence,
  CommitItem,
  EstimateItem,
  EstimateResult,
} from "@/lib/types";

/**
 * 前端估时编排：带子任务拆分后单条输出变长，成果多时一次请求会超出 max_tokens，
 * 因此按 ESTIMATE_BATCH_SIZE 拆批并发请求，再按原下标拼回。
 * 每批的提交与证据只带该批成果关联的部分，减小请求体。
 * 任一批在重试一次后仍失败则整体失败，不出不完整的估算。
 */

export interface EstimateRequest {
  repo: string;
  achievements: Achievement[];
  commits: CommitItem[];
  evidence: CommitEvidence[];
  projectContext?: string;
  settings: { baseUrl: string; apiKey: string; model: string };
}

export type EstimateOutcome =
  | { ok: true; result: EstimateResult }
  | { ok: false; error: string; code?: string };

type ChunkResponse =
  | { ok: true; data: EstimateResult }
  | { ok: false; status: number; error: string; code?: string };

async function postChunk(body: unknown): Promise<ChunkResponse> {
  let res: Response;
  try {
    res = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: "网络错误，请稍后重试" };
  }
  let data: Partial<EstimateResult> & { error?: string; code?: string } = {};
  try {
    data = await res.json();
  } catch {
    // 网关超时等场景返回的是 HTML，按状态码处理
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data.error || `估算失败（${res.status}）`,
      code: data.code,
    };
  }
  return {
    ok: true,
    data: {
      items: Array.isArray(data.items) ? data.items : [],
      assumptions: data.assumptions ?? "",
    },
  };
}

export async function runEstimate(req: EstimateRequest): Promise<EstimateOutcome> {
  const indexed = req.achievements.map((a, index) => ({ a, index }));
  const chunks = splitBatches(indexed, ESTIMATE_BATCH_SIZE);
  const results: EstimateResult[] = new Array(chunks.length);
  let cursor = 0;
  // 放在对象里：闭包内的赋值不会被 TS 的控制流收窄追踪
  const state: { failure: { error: string; code?: string } | null } = { failure: null };

  function bodyFor(chunk: typeof indexed) {
    const shas = new Set(chunk.flatMap(({ a }) => a.shas));
    const commits = req.commits.filter((c) => shas.has(c.shortSha));
    const fullShas = new Set(commits.map((c) => c.sha));
    return {
      repo: req.repo,
      achievements: chunk.map(({ a }) => ({
        title: a.title,
        description: a.description,
        category: a.category,
        shas: a.shas,
      })),
      commits: commits.map((c) => ({ sha: c.sha, shortSha: c.shortSha, title: c.title })),
      evidence: req.evidence.filter((e) => fullShas.has(e.sha)),
      projectContext: req.projectContext,
      settings: req.settings,
    };
  }

  async function worker() {
    while (cursor < chunks.length && !state.failure) {
      const i = cursor++;
      const body = bodyFor(chunks[i]);
      let r = await postChunk(body);
      if (!r.ok && (r.status === 0 || r.status >= 500) && r.code !== "TRUNCATED" && !state.failure) {
        r = await postChunk(body);
      }
      if (!r.ok) {
        state.failure ??= {
          error: chunks.length > 1 ? `第 ${i + 1}/${chunks.length} 批估算失败：${r.error}` : r.error,
          code: r.code,
        };
        return;
      }
      results[i] = r.data;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ESTIMATE_BATCH_CONCURRENCY, chunks.length) }, worker)
  );
  if (state.failure) return { ok: false, ...state.failure };

  // 服务端 index 为批内下标，映射回全局下标
  const items: EstimateItem[] = results.flatMap((r, ci) =>
    r.items.map((it) => ({ ...it, index: chunks[ci][it.index]?.index ?? it.index }))
  );
  return {
    ok: true,
    result: {
      items,
      assumptions: results.find((r) => r.assumptions)?.assumptions ?? "",
    },
  };
}
