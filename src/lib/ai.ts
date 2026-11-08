import { httpPost, type SimpleResponse } from "@/lib/http";

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 用户设置优先，其次服务端环境变量 */
export function resolveAiConfig(settings?: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): AiConfig {
  return {
    baseUrl: (
      settings?.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, ""),
    apiKey: settings?.apiKey || process.env.OPENAI_API_KEY || "",
    model: settings?.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
  };
}

export const AI_NOT_CONFIGURED_MESSAGE =
  "尚未配置 AI 服务。请点击右上角「设置」，填写任意 OpenAI 兼容服务的 API 地址、密钥和模型。";

export type ChatJsonResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string; code?: "TRUNCATED" };

/**
 * 默认输出 token 上限。
 * 不显式设置时各家 OpenAI 兼容服务的默认值差异很大（部分只有 500 / 2048），
 * 50 条提交的成果 JSON 会被截断成无法解析的半截文本。
 */
const DEFAULT_MAX_TOKENS = 8192;

type TokenUsage = {
  completionTokens?: number;
  /** OpenAI 兼容服务在 usage.completion_tokens_details.reasoning_tokens 中给出 */
  reasoningTokens?: number;
  /** 未给出推理 token 数时，用 reasoning_content（DeepSeek 等返回的推理文本）的长度兜底 */
  reasoningChars?: number;
};

function readUsage(usage: unknown, message: unknown): TokenUsage {
  const u = (usage ?? {}) as {
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const reasoning = (message as { reasoning_content?: unknown } | null)?.reasoning_content;
  return {
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    reasoningChars: typeof reasoning === "string" && reasoning ? reasoning.length : undefined,
  };
}

/**
 * 调用 OpenAI 兼容的 chat/completions 并解析 JSON 输出。
 *
 * httpPost 内部有 socket 级 timeoutMs，外层再用 Promise.race 兜底
 * （DNS / 建连阶段卡住时 socket 超时不生效），确保在阈值内返回。
 */
export async function chatJson(
  cfg: AiConfig,
  system: string,
  user: string,
  opts: { timeoutMs: number; temperature?: number; maxTokens?: number }
): Promise<ChatJsonResult> {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";

  let res: SimpleResponse;
  try {
    const aiFetch = httpPost(
      `${cfg.baseUrl}/chat/completions`,
      JSON.stringify({
        model: cfg.model,
        temperature: opts.temperature ?? 0.35,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        proxy: proxy || undefined,
        timeoutMs: opts.timeoutMs,
      }
    );
    res = await Promise.race([
      aiFetch,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(Object.assign(new Error("timeout"), { name: "AbortError" })),
          opts.timeoutMs + 1000
        )
      ),
    ]);
  } catch (e) {
    const aborted = (e as { name?: string } | null)?.name === "AbortError";
    return {
      ok: false,
      status: 504,
      error: aborted
        ? "AI 服务响应超时，请减少选中的提交数量或稍后重试。"
        : "无法连接 AI 服务，请检查 API 地址是否可访问。",
    };
  }

  if (!res.ok) {
    const status = res.status;
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    if (status === 401) {
      return {
        ok: false,
        status: 401,
        error: `AI 服务鉴权失败（401），请检查 API 密钥。${detail}`,
      };
    }
    if (status === 404) {
      return {
        ok: false,
        status: 404,
        error: `AI 服务或模型不存在（404），请检查 API 地址与模型名称。${detail}`,
      };
    }
    return {
      ok: false,
      status: 502,
      error: `AI 服务返回错误（${status}）。${detail}`,
    };
  }

  let content = "";
  let finishReason = "";
  let usage: TokenUsage = {};
  try {
    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    content = message?.content ?? "";
    finishReason = String(data?.choices?.[0]?.finish_reason ?? "");
    usage = readUsage(data?.usage, message);
  } catch {
    return { ok: false, status: 502, error: "AI 返回格式异常，请重试一次" };
  }
  // 输出达到 token 上限：JSON 必然不完整，重试同样的输入也无济于事，单独提示。
  // 附上 token 用量，区分「正文太长」与「思考模式的推理占满上限」
  if (finishReason === "length") {
    const limit = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    console.warn("[ai] output truncated", { model: cfg.model, limit, ...usage });
    const reasoningHeavy =
      usage.reasoningTokens !== undefined && usage.reasoningTokens > limit / 2;
    const detail = [
      usage.completionTokens !== undefined && `输出 ${usage.completionTokens}/${limit} token`,
      usage.reasoningTokens !== undefined && `其中推理 ${usage.reasoningTokens}`,
      usage.reasoningTokens === undefined &&
        usage.reasoningChars &&
        `含推理过程约 ${usage.reasoningChars} 字`,
    ]
      .filter(Boolean)
      .join("，");
    return {
      ok: false,
      status: 502,
      code: "TRUNCATED",
      error: `AI 输出超出长度上限被截断${detail ? `（${detail}）` : ""}。${
        reasoningHeavy || (usage.reasoningTokens === undefined && usage.reasoningChars)
          ? "大部分输出用在了推理过程上，请在设置中换成非思考模式的模型。"
          : "请减少选中的提交数量；若使用的是思考（推理）模式的模型，建议换成非思考模式。"
      }`,
    };
  }
  if (!content) {
    return { ok: false, status: 502, error: "AI 返回内容为空，请稍后重试" };
  }
  try {
    return { ok: true, data: JSON.parse(content) };
  } catch {
    return { ok: false, status: 502, error: "AI 返回格式异常，请重试一次" };
  }
}

/**
 * 把模型返回的哈希映射回真实短哈希。
 * GitHub 短哈希 7 位、GitLab 8 位，模型可能原样返回或截断，按前 7 位匹配。
 */
export function makeShaResolver(shortShas: string[]) {
  const byPrefix = new Map(shortShas.map((s) => [s.slice(0, 7), s]));
  return (raw: unknown): string | undefined =>
    byPrefix.get(String(raw).trim().toLowerCase().slice(0, 7));
}
