# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

Next.js here is 16.x (with React 19.3, Tailwind v4). APIs differ from older versions; consult `node_modules/next/dist/docs/` before using framework APIs. `next.config.ts` enables `cacheComponents`, `partialPrefetching`, and `output: "standalone"`.

## Commands

- `npm run dev` - dev server on http://localhost:4000
- `npm run build` - production build (standalone output in `.next/standalone`)
- `npm start` - builds, then runs `scripts/start-standalone.js`, which copies `public/` and `.next/static` into the standalone dir (standalone output omits them) and starts `server.js` on `$PORT` / `$HOST` (default `0.0.0.0:4000`)
- `npm run lint` - ESLint 9 flat config (`eslint.config.mjs`, `eslint-config-next`)
- Type check: `npx tsc --noEmit`

There is no test framework configured.

## What the app does

Commit2Value turns Git commits into customer-facing achievement reports. The user picks a GitHub or GitLab repo, branch, and time range, selects commits, and the server enriches them with code evidence (files changed, +/- lines, linked PRs) and asks an OpenAI-compatible chat model to produce structured achievements plus a report. UI copy, prompts, comments, and error messages are in Chinese (zh-CN); keep new user-facing text and comments consistent with that.

## Architecture

**Client** - `src/app/page.tsx` (`"use client"`, ~1.6k lines) holds all state; newer features live in their own components (`branch-multi-select.tsx`, `estimate-panel.tsx`) and new UI should follow that rather than growing page.tsx. Author filtering is client-side over loaded commits (`visibleCommits`); the selection is kept a subset of the visible commits. Settings (`AiSettings` in `src/lib/types.ts`: AI base URL/key/model, provider, GitHub/GitLab base URLs and tokens, range days) are stored in `localStorage` under `c2v-ai-settings` and sent in each API request body. `src/components/settings-dialog.tsx` edits them; `src/components/ui/` are shadcn-style primitives (Radix + CVA + `cn()` from `src/lib/utils.ts`). `src/lib/present.ts` holds category/impact display metadata and the report exporters (plain text, Markdown, Word-compatible HTML, `downloadFile`), which take a `ReportExportOptions` object. The report's detail sections (achievements grouped by category, a weekly timeline, and a commit heatmap) are derived client-side in `src/lib/report-details.ts` from the achievements and the analyzed commits, with no AI call. The heatmap math lives in `src/lib/heatmap.ts`: it buckets days in local time and assigns color levels by quantile. That module is shared by `commit-heatmap.tsx` and the Word export, which renders the heatmap as a colored table because Word handles inline SVG poorly.

**API routes** (`src/app/api/*/route.ts`, all POST/GET handlers):
- `github/repo`, `github/commits` - fetch repo info/branches and commits. Despite the `github/` path, both branch on `provider === "gitlab"` and dispatch to `src/lib/gitlab.ts`. `commits` takes multiple `branches` (first page each) or `pages: {branch: page}` (load more), fetches per branch with limited concurrency, dedupes by SHA (`CommitItem.branches` records membership), and returns per-branch `cursors`. Partial branch failures come back as `warnings`; only all-failed is an error.
- `analyze` - main pipeline: evidence enrichment -> prompt assembly -> AI call -> defensive normalization of the model's JSON (shared helpers in `src/lib/achievements.ts`: string length truncation, enum whitelisting for `category`/`impact`, `shas` resolved back to submitted short SHAs via `makeShaResolver`, which handles GitHub 7-char and GitLab 8-char hashes) -> `AnalyzeResult`, including per-commit `evidence` for reuse. One request accepts at most `ANALYZE_BATCH_SIZE` commits (`src/lib/limits.ts`); more is rejected with 400, never silently truncated. `mode: "batch"` uses a prompt variant that returns achievements only (no report) to save output tokens. The system prompts define the output contract; keep them in sync with `src/lib/types.ts` and the normalization code.
- Whichever path writes the report (`analyze` in non-batch mode, or `merge`) also returns `report.risks` (0-`MAX_REPORT_RISKS` items, evidence-based only).
- `analyze/merge` - merges the achievements of several batches and writes the overall report. The model returns only groups to merge (`sources`, 1-based); ungrouped achievements are kept as-is, and `shas`/`evidence` are unioned server-side from the sources. If the AI call fails, it degrades to plain concatenation with a `warning`.
- Batching is orchestrated client-side in `src/lib/analyze-client.ts` (`runAnalyze`), because each request must fit the gateway timeout: up to `MAX_ANALYZE_COMMITS` total, balanced batches, `ANALYZE_BATCH_CONCURRENCY` in parallel, each batch retried once on 5xx/network errors, and any final batch failure fails the whole run. A `TRUNCATED` batch is not retried as-is: it is split in half recursively, down to `MIN_SPLIT_SIZE` commits. At most one batch goes in a single plain `analyze` call, with no merge step; if that call is truncated, the run falls back to the split-and-merge path. Before any batch, the client calls `project-context` once and passes its text to every batch, to merge, and to estimate.
- `project-context` - reads key repo docs at the first selected branch (README, up to 3 `docs/*.md`, AGENTS/CLAUDE.md, CHANGELOG head, package.json summary) via `src/lib/project-docs.ts`, cleaned and capped at `MAX_CONTEXT_CHARS`, with a 5s budget. It always returns 200 (empty on failure). Prompts treat it as background for terminology only, never as evidence of work done.
- `estimate` - effort estimation for an existing result, using the achievements plus the `evidence` returned by analyze (no second code-platform fetch). The AI returns only hour ranges plus a 1-4 item subtask breakdown per achievement (`tasks`; the server rescales the tasks if their sum falls outside the range). Because the breakdown lengthens the output, `src/lib/estimate-client.ts` splits requests into chunks of `ESTIMATE_BATCH_SIZE` and remaps indices. When the user edits an item's hours, its tasks are rescaled proportionally (`scaleTasks`). All money is computed client-side in `src/lib/pricing.ts` (cost = quantity x cost rate, quote = cost x (1 + margin)). Exports (`src/lib/present.ts`) can optionally include the quote via `QuoteForExport`, which by design carries no cost or margin.
- `cron/weekly-report` - headless entry point for `.github/workflows/weekly-report.yml` (Mondays 01:00 UTC). Uses only env vars. Note it is a separate, simpler implementation: it uses global `fetch` instead of `httpPost`, a shorter inline prompt, and lighter output normalization than `analyze`.
- `github/oauth` + `github/oauth/callback` - OAuth code flow with state + PKCE in httpOnly cookies. The callback only lists accessible repos; the token is not persisted or returned. The PAT in settings is the primary auth path.
- `diag` - connectivity/latency probe (DNS, GitHub, common AI hosts).

**Server lib**:
- `src/lib/ai.ts` - shared OpenAI-compatible JSON chat call (`chatJson`) with the timeout race and error-status mapping, plus `resolveAiConfig` (client settings > env). Use it for new AI endpoints. It always sends `max_tokens` (default 8192, because provider defaults can be as low as 500) and maps `finish_reason: "length"` to `code: "TRUNCATED"`. The error message includes token usage, with reasoning tokens or `reasoning_content` length, so a thinking-mode model eating the budget is distinguishable from overly long output.
- `src/lib/http.ts` - hand-rolled GET/POST on Node `http`/`https` with HTTP CONNECT proxy support via `HTTPS_PROXY`, falling back to direct connection on proxy failure. It exists deliberately to avoid undici/ESM import problems in some build environments; use `httpGet`/`httpPost` for outbound calls instead of adding a fetch library.
- `src/lib/github.ts` - `ghFetch` token precedence: explicit user token > `GITHUB_TOKEN` env > anonymous. If the env token returns 401 it is marked invalid for the process lifetime and requests fall back to anonymous. `parseRepoInput` accepts `owner/repo` or github.com URLs.
- `src/lib/gitlab.ts` - GitLab equivalents; `owner` is the full namespace (subgroups allowed), and `owner/name` is URL-encoded as the project ID. GitLab evidence has no line counts or PRs (always 0 / empty), but does carry `diffExcerpt`.
- `src/lib/evidence.ts` - concurrency-limited per-commit detail fetching (max `ANALYZE_BATCH_SIZE` commits, 10 workers) with a time budget, wrapped by `enrichWithEvidenceSafe` in a hard `Promise.race` cap. Each `CommitEvidence` carries a `diffExcerpt` built by `src/lib/diff.ts` from the patches already present in the commit detail response, so it costs no extra requests. The builder skips lock files, build output and binaries, ranks files by change size, keeps only hunk headers and +/- lines, and applies a per-commit budget. The UI shows evidence and document coverage in `analysis-coverage.tsx`, so degraded evidence is visible.

**Timeout design** - the deployment sits behind a gateway with a response timeout (524s were observed), so every external stage has its own budget: ~8s per GitHub request, ~6-6.5s total for evidence, 75s for the AI call with a 76s outer race. Evidence failures degrade to commit messages only and never fail the request. Preserve this degrade-don't-fail behavior when changing the pipeline.

## Environment variables

`OPENAI_API_KEY`, `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), `OPENAI_MODEL` (default `gpt-4o-mini`) - fallbacks when the client sends no AI settings. `GITHUB_TOKEN`, `GITHUB_API_BASE_URL`, `GITLAB_API_BASE_URL`, `HTTPS_PROXY`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `APP_BASE_URL`, `C2V_REPO` (default repo for the cron route).

The path alias `@/*` maps to `src/*`.
