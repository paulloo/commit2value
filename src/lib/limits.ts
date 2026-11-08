/**
 * 前后端共用的数量上限。
 *
 * 单个 /api/analyze 请求受网关超时约束，因此超过 ANALYZE_BATCH_SIZE 的选择由前端拆成多批
 * 分别请求，再调用 /api/analyze/merge 合并。超出 MAX_ANALYZE_COMMITS 时前端阻止提交，
 * 服务端也会拒绝，绝不静默截断。
 */

/** 可选的统计时间范围（天），设置对话框与提交列表的快捷切换共用；上限与 commits 接口的 90 天一致 */
export const RANGE_DAY_OPTIONS = [7, 14, 30, 90] as const;

/**
 * 单批送入模型的提交数（也是单次证据拉取的上限）。
 * 每条提交附约 1.5k 字的改动摘录，30 条约 5 万字输入；超时或输出截断频繁时应调小。
 */
export const ANALYZE_BATCH_SIZE = 30;

/** 一次分析（所有批次合计）的提交总数上限 */
export const MAX_ANALYZE_COMMITS = 200;

/** 批次并发数：受 AI 服务与代码平台（证据拉取）的速率限制约束 */
export const ANALYZE_BATCH_CONCURRENCY = 2;

/** 合并接口接受的成果条数上限（200 条提交最多 7 批，每批至多 MAX_BATCH_ACHIEVEMENTS 条） */
export const MAX_MERGE_ACHIEVEMENTS = 120;

/** 单批分析最多保留的成果条数（防止模型输出失控） */
export const MAX_BATCH_ACHIEVEMENTS = 15;

/**
 * 估时接口单次接受的成果条数上限（服务端兜底）。
 * 含子任务拆分后每条约 160 个输出 token，80 条会超出默认 max_tokens，
 * 因此前端按 ESTIMATE_BATCH_SIZE 拆批请求，这里只防止异常调用。
 */
export const MAX_ESTIMATE_ACHIEVEMENTS = 80;

/** 前端估时拆批大小：20 条约 3.2k 输出 token，留足余量且单批耗时可控 */
export const ESTIMATE_BATCH_SIZE = 20;

/** 估时并发批数 */
export const ESTIMATE_BATCH_CONCURRENCY = 2;

/** 单次请求最多并发拉取的分支数（每个分支每页一次 API 调用，受速率限额约束） */
export const MAX_BRANCHES = 30;
