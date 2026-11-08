#!/usr/bin/env node
/**
 * 生产启动脚本（适配单端口托管环境）。
 *
 * Next.js standalone 产物不会自动携带 public/ 与 .next/static，
 * 这里在启动前补齐，否则页面样式与静态资源会404。
 * 同时确保监听 $PORT 并绑定 0.0.0.0，便于反向代理访问。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// 脚本位于 scripts/ 下，项目根目录需上溯一级
const root = path.resolve(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");
const serverFile = path.join(standalone, "server.js");

if (!fs.existsSync(serverFile)) {
  console.error(
    "未找到 .next/standalone/server.js，请先运行 `npm run build`"
  );
  process.exit(1);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// standalone 内部目录结构可能多一层（monorepo 时按 server.js 所在位置对齐）
const staticSrc = path.join(root, ".next", "static");
const publicSrc = path.join(root, "public");

if (fs.existsSync(staticSrc)) {
  copyDir(staticSrc, path.join(path.dirname(serverFile), ".next", "static"));
}
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, path.join(path.dirname(serverFile), "public"));
}

const port = process.env.PORT || "4000";
const host = process.env.HOST || "0.0.0.0";

const child = spawn(process.execPath, [serverFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    HOSTNAME: host,
    NODE_ENV: "production",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));