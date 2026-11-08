# Commit2Value

把 Git 提交变成客户看得懂的成果汇报。

程序员写的是 commit，客户想看的是价值。Commit2Value 读取 GitHub / GitLab 仓库的代码改动，用 AI 归纳出有据可查的工作成果，附上工时估算与报价，几分钟生成一份可以直接发送的阶段汇报。

使用流程：选中提交 → 自动翻译 → 一键发送给客户。

## 主要功能

- **提交翻译成成果**：结合改动文件、增删行数、关联 PR 与 diff 摘录归纳成果，只依据代码证据，不编造指标或数字。
- **GitHub / GitLab 多分支**：支持私有仓库、GitHub Enterprise 与自托管 GitLab；多分支合并去重，按作者筛选；提交较多时自动分批分析再合并。
- **工时估算与报价**：每条成果给出工时区间与子任务拆分；金额按你设置的费率与利润率在本地计算，导出时只带报价，不带成本与利润率。
- **活跃度与详细报告**：提交热力图、按类别的工作明细、按周进展、风险与待跟进。
- **一键导出**：复制纯文本直接发给客户，或导出 Markdown、Word 文档。
- **开源可自托管**：AI 密钥与访问令牌只保存在浏览器本地；可接入任意 OpenAI 兼容模型（OpenAI、DeepSeek、Moonshot 等）。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/paulloo/commit2value.git
cd commit2value
npm install
npm run dev
```

打开 <http://localhost:4000>，点右上角设置填写 AI 服务的 API 地址、Key 与模型，然后输入仓库（如 `facebook/react`）即可开始。私有仓库需要在设置中填写 GitHub 个人访问令牌或 GitLab 令牌（`read_api`）。

## 部署

```bash
npm start
```

`npm start` 会先构建，再以 standalone 模式在 `$HOST:$PORT`（默认 `0.0.0.0:4000`）启动服务。

## 环境变量

全部可选。用户在页面设置中填写的值优先于环境变量。

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | 页面未填写 AI 配置时的默认值（默认 `https://api.openai.com/v1`、`gpt-4o-mini`） |
| `GITHUB_TOKEN` | 服务端默认 GitHub 令牌，提高匿名访问的速率限制 |
| `GITHUB_API_BASE_URL` / `GITLAB_API_BASE_URL` | GitHub Enterprise / 自托管 GitLab 的 API 地址 |
| `HTTPS_PROXY` | 出站请求代理（HTTP CONNECT），代理失败时回退直连 |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` / `APP_BASE_URL` | 可选的 GitHub OAuth 登录 |
| `C2V_REPO` | 定时周报接口使用的默认仓库 |

## 技术栈

Next.js 16（App Router）、React 19、Tailwind CSS v4、Radix UI。AI 调用使用 OpenAI 兼容的 Chat Completions 接口。

## 参与贡献

欢迎提交 [Issue](https://github.com/paulloo/commit2value/issues) 与 Pull Request。提交前请运行：

```bash
npm run lint
npx tsc --noEmit
```
