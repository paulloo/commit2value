import {
  ArrowRight,
  Calculator,
  CalendarDays,
  FileDown,
  GitBranch,
  GitFork,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GithubMark } from "@/components/github-mark";
import { REPO_URL } from "@/lib/site";

const FEATURES = [
  {
    icon: Sparkles,
    title: "提交翻译成成果",
    desc: "AI 结合改动文件、增删行与 diff 摘录归纳工作成果，只依据代码证据，不编造指标。",
  },
  {
    icon: GitBranch,
    title: "GitHub / GitLab 多分支",
    desc: "支持私有仓库与自托管 GitLab，多分支合并去重，按作者筛选，大批量提交自动分批分析。",
  },
  {
    icon: Calculator,
    title: "工时估算与报价",
    desc: "按成果给出工时区间与子任务拆分，金额按你的费率与利润率计算，成本永不导出。",
  },
  {
    icon: CalendarDays,
    title: "活跃度与详细报告",
    desc: "提交热力图、按类别的工作明细、按周进展、风险与待跟进，一份报告讲清楚这段时间做了什么。",
  },
  {
    icon: FileDown,
    title: "一键导出",
    desc: "复制纯文本直接发给客户，或导出 Markdown、Word 文档，排版开箱即用。",
  },
  {
    icon: ShieldCheck,
    title: "开源可自托管",
    desc: "密钥只存在浏览器本地；可部署在自己的服务器，接入任意 OpenAI 兼容模型。",
  },
] as const;

const STEPS = [
  { icon: GitFork, label: "选中提交" },
  { icon: Sparkles, label: "自动翻译" },
  { icon: Send, label: "一键发送给客户" },
] as const;

/**
 * 首屏介绍：主题、主要功能与开源地址。
 * showFeatures = 尚未加载仓库；加载后只保留流程条，让工作区靠前。
 */
export function SiteHero({
  showFeatures,
  onStart,
}: {
  showFeatures: boolean;
  onStart: () => void;
}) {
  return (
    <section className="mb-8 space-y-6">
      {showFeatures && (
        <div className="mx-auto max-w-3xl space-y-4 pt-2 text-center">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground"
          >
            <GithubMark className="size-3.5" />
            开源项目 · 欢迎 Star 与贡献
            <ArrowRight className="size-3" />
          </a>
          <h2 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            把 Git 提交变成
            <span className="text-primary">客户看得懂</span>
            的成果汇报
          </h2>
          <p className="mx-auto max-w-2xl text-sm leading-relaxed text-muted-foreground text-pretty sm:text-base">
            程序员写的是 commit，客户想看的是价值。Commit2Value 读取代码改动，归纳出有据可查的工作成果，
            附上工时与报价，几分钟生成一份可以直接发送的阶段汇报。
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="lg" onClick={onStart}>
              开始使用
              <ArrowRight />
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                <GithubMark />
                查看源码
              </a>
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
        {STEPS.map((s, i) => (
          <span key={s.label} className="flex items-center gap-2">
            {i > 0 && <ArrowRight className="size-4 text-primary/60" />}
            <span className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 shadow-xs">
              <s.icon className="size-4 text-primary" />
              {s.label}
            </span>
          </span>
        ))}
      </div>

      {showFeatures && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li
              key={f.title}
              className="rounded-xl border bg-card/80 p-4 shadow-xs backdrop-blur-sm"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="size-4" />
                </span>
                <span className="text-sm font-semibold">{f.title}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
