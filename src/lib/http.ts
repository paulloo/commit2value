import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

export const DEFAULT_GH_BASE = "https://api.github.com";

/**
 * 统一的 HTTP 请求工具。
 *
 * 不依赖 undici 等第三方 ESM 包（它们在部分构建环境下的静态导入会失败），
 * 直接使用 Node 内置 http/https，并按需通过 HTTPS_PROXY 走本地代理。
 */

type FetchOptions = {
  headers?: Record<string, string>;
  /** 代理地址，如 http://127.0.0.1:7897 */
  proxy?: string;
  timeoutMs?: number;
};

export type SimpleResponse = {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  json: () => Promise<any>;
};

/** 通过代理请求 https 地址 */
function requestViaProxy(
  targetUrl: string,
  opts: FetchOptions
): Promise<SimpleResponse> {
  const proxyUrl = new URL(opts.proxy!);
  const target = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: "GET",
        path: target.toString(),
        headers: { ...opts.headers, host: target.host },
        timeout: opts.timeoutMs ?? 20000,
      },
      (proxyRes: IncomingMessage) => {
        const status = proxyRes.statusCode ?? 0;
        // 代理请求 https 目标时返回 200，再用 CONNECT 建立隧道
        if (status === 200 && proxyRes.headers["proxy-agent"] !== undefined) {
          proxyRes.resume();
          return;
        }
        const chunks: Buffer[] = [];
        proxyRes.on("data", (c: Buffer) => chunks.push(c));
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(makeResponse(status, body));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

/** 通过 CONNECT 隧道请求 https 地址（标准 HTTP 代理协议） */
function requestViaConnect(
  targetUrl: string,
  opts: FetchOptions
): Promise<SimpleResponse> {
  const proxyUrl = new URL(opts.proxy!);
  const target = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      timeout: opts.timeoutMs ?? 20000,
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：${res.statusCode}`));
        return;
      }
      const tlsReq = https.request(
        {
          socket: socket as unknown as Socket,
          agent: false,
          host: target.hostname,
          path: target.pathname + target.search,
          method: "GET",
          headers: opts.headers,
          timeout: opts.timeoutMs ?? 20000,
        } as https.RequestOptions,
        (tlsRes) => {
          const chunks: Buffer[] = [];
          tlsRes.on("data", (c: Buffer) => chunks.push(c));
          tlsRes.on("end", () => {
            resolve(
              makeResponse(
                tlsRes.statusCode ?? 0,
                Buffer.concat(chunks).toString("utf8")
              )
            );
          });
        }
      );
      tlsReq.on("error", reject);
      tlsReq.on("timeout", () => tlsReq.destroy(new Error("请求超时")));
      tlsReq.end();
    });

    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

/** 直连请求（无代理） */
function requestDirect(
  targetUrl: string,
  opts: FetchOptions
): Promise<SimpleResponse> {
  const target = new URL(targetUrl);
  const client = target.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + target.search,
        method: "GET",
        headers: opts.headers,
        timeout: opts.timeoutMs ?? 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(
            makeResponse(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))
          );
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

function makeResponse(status: number, body: string): SimpleResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/**
 * 通用 GET 请求：优先走代理（若配置），失败自动回退直连。
 */
export async function httpGet(
  url: string,
  opts: FetchOptions = {}
): Promise<SimpleResponse> {
  const proxy = opts.proxy;
  if (!proxy) return requestDirect(url, opts);
  try {
    return await requestViaConnect(url, opts);
  } catch {
    // 代理不可用时回退直连
    return requestDirect(url, opts);
  }
}

/** 通用 POST 请求（用于 OAuth 换令牌、AI 调用），支持代理 */
export async function httpPost(
  url: string,
  body: string,
  opts: FetchOptions = {}
): Promise<SimpleResponse> {
  const target = new URL(url);
  const payload = Buffer.from(body, "utf8");

  const run = (viaProxy: boolean): Promise<SimpleResponse> => {
    if (viaProxy && opts.proxy) return postViaConnect(url, body, opts);
    return new Promise((resolve, reject) => {
      const client = target.protocol === "http:" ? http : https;
      const req = client.request(
        {
          host: target.hostname,
          port: target.port || (target.protocol === "http:" ? 80 : 443),
          path: target.pathname + target.search,
          method: "POST",
          headers: {
            ...opts.headers,
            "Content-Length": String(payload.length),
          },
          timeout: opts.timeoutMs ?? 20000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve(
              makeResponse(
                res.statusCode ?? 0,
                Buffer.concat(chunks).toString("utf8")
              )
            )
          );
        }
      );
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  };

  if (!opts.proxy) return run(false);
  try {
    return await run(true);
  } catch {
    // 代理失败回退直连
    return run(false);
  }
}

/** 通过 CONNECT 隧道发POST（复用 GET 的隧道逻辑） */
function postViaConnect(
  targetUrl: string,
  body: string,
  opts: FetchOptions
): Promise<SimpleResponse> {
  const proxyUrl = new URL(opts.proxy!);
  const target = new URL(targetUrl);
  const payload = Buffer.from(body, "utf8");

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      timeout: opts.timeoutMs ?? 20000,
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：${res.statusCode}`));
        return;
      }
      const tlsReq = https.request(
        {
          socket: socket as unknown as Socket,
          agent: false,
          host: target.hostname,
          path: target.pathname + target.search,
          method: "POST",
          headers: {
            ...opts.headers,
            "Content-Length": String(payload.length),
          },
          timeout: opts.timeoutMs ?? 20000,
        } as https.RequestOptions,
        (tlsRes) => {
          const chunks: Buffer[] = [];
          tlsRes.on("data", (c: Buffer) => chunks.push(c));
          tlsRes.on("end", () =>
            resolve(
              makeResponse(
                tlsRes.statusCode ?? 0,
                Buffer.concat(chunks).toString("utf8")
              )
            )
          );
        }
      );
      tlsReq.on("error", reject);
      tlsReq.on("timeout", () => tlsReq.destroy(new Error("请求超时")));
      tlsReq.write(payload);
      tlsReq.end();
    });

    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}