export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  branches: string[];
  description?: string;
  provider?: "github" | "gitlab";
}

export interface CommitItem {
  sha: string;
  shortSha: string;
  title: string;
  description: string;
  date: string; // ISO string
  author?: string;
  authorAvatar?: string;
  /** 包含该提交的分支（多分支拉取时按 SHA 去重后合并） */
  branches?: string[];
}

/** 服务端批量补全的代码证据（来自 /commits/{sha} 详情接口） */
export interface CommitEvidence {
  sha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  filePaths: string[];
  prNumbers: number[];
  /** 改动摘录：按改动量挑选源码文件，只保留增删行与 hunk 头（见 src/lib/diff.ts） */
  diffExcerpt?: string;
}

/** 从仓库文档提取的项目背景，只用于帮助模型理解业务术语，不作为成果依据 */
export interface ProjectContext {
  /** 拼接、清洗后的文本（已截断） */
  text: string;
  /** 实际读取到的文件路径 */
  sources: string[];
}

/** 成果分类，用于图标与配色 */
export type AchievementCategory =
  | "feature"
  | "performance"
  | "experience"
  | "stability"
  | "efficiency"
  | "security"
  | "other";

/** 影响程度 */
export type ImpactLevel = "high" | "medium" | "low";

export interface Achievement {
  title: string;
  description: string;
  /** 面向客户的价值说明（为什么这个成果重要） */
  value: string;
  shas: string[];
  status: "evidenced" | "unverified";
  note?: string;
  category?: AchievementCategory;
  impact?: ImpactLevel;
  /** 代码层面的客观证据（文件路径、增删行数等） */
  evidence?: string[];
}

export interface AnalyzeStats {
  commitCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  contributorCount: number;
  prCount: number;
  topContributors: Array<{ name: string; count: number; avatar?: string }>;
}

export interface AnalyzeResult {
  achievements: Achievement[];
  /** 结构化客户版汇报 */
  report: ReportContent;
  stats?: AnalyzeStats;
  /** 本次分析实际拿到的逐提交代码证据，供估时接口复用，避免重复请求代码平台 */
  evidence?: CommitEvidence[];
  /** 本次分析使用的项目背景，供估时复用与界面展示 */
  context?: ProjectContext;
}

/** 结构化报告：便于前端排版与导出 */
export interface ReportContent {
  /** 一句话总览 */
  summary: string;
  /** 分条成果（与成果卡一致） */
  items: Array<{ title: string; detail: string; status: "evidenced" | "unverified" }>;
  /** 下一步计划 */
  nextSteps: string;
  /** 风险与待跟进事项（仅依据代码证据，可为空；旧数据与定时任务没有该字段） */
  risks?: string[];
}

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  // 可选：GitHub 个人访问令牌（用于私有仓库 / GitHub Enterprise），以及自定义 API 地址
  ghBaseUrl?: string;
  ghToken?: string;
  /** 时间范围（天） */
  rangeDays?: number;
  /** 代码托管平台 */
  provider?: "github" | "gitlab";
  /** GitLab 自托管地址 / API 地址 */
  glBaseUrl?: string;
  /** GitLab Personal Access Token（需 read_api） */
  glToken?: string;
  /** 估时报价参数 */
  pricing?: PricingSettings;
}

/** 计价单位：小时 / 人天 */
export type WorkUnit = "hour" | "day";

export interface PricingSettings {
  /** 币种显示符号，如 CNY、USD */
  currency: string;
  unit: WorkUnit;
  /** 内部成本费率（按 unit 计：元/小时 或 元/人天） */
  costRate: number;
  /** 利润率（百分比），报价 = 成本 × (1 + marginPct / 100) */
  marginPct: number;
  /** 每人天折合小时数 */
  hoursPerDay: number;
}

/** AI 给出的单条成果工时估算（小时） */
export interface EstimateItem {
  /** 对应 achievements 的下标 */
  index: number;
  hoursLow: number;
  hoursHigh: number;
  /** 估算依据 */
  basis: string;
  /** 子任务拆分（小时），合计落在 [hoursLow, hoursHigh] 内；AI 未给出时为空 */
  tasks?: EstimateTask[];
}

export interface EstimateTask {
  name: string;
  hours: number;
}

export interface EstimateResult {
  items: EstimateItem[];
  /** 估算前提与假设 */
  assumptions: string;
}

/** 对外报价（不含成本与利润率） */
export interface QuoteForExport {
  currency: string;
  unitLabel: string;
  lines: Array<{
    title: string;
    quantity: number;
    amount: number;
    /** 子任务工作量（按计价单位），不单独报价 */
    tasks?: Array<{ name: string; quantity: number }>;
  }>;
  totalQuantity: number;
  totalAmount: number;
}