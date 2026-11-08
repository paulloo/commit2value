import { FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommitEvidence, ProjectContext } from "@/lib/types";

/**
 * 展示本次分析的输入覆盖情况：多少提交拿到了代码证据 / 改动摘录、读取了哪些项目文档。
 * 证据拉取是「超时即降级」的，这里把降级暴露出来，避免用户误以为每条提交都看过代码。
 */
export function AnalysisCoverage({
  commitCount,
  evidence,
  context,
}: {
  commitCount: number;
  evidence: CommitEvidence[];
  context?: ProjectContext;
}) {
  if (commitCount === 0) return null;
  const withEvidence = Math.min(evidence.length, commitCount);
  const withDiff = evidence.filter((e) => e.diffExcerpt).length;
  const partial = withEvidence < commitCount;
  const sources = context?.sources ?? [];

  return (
    <div
      className={cn(
        "space-y-1 rounded-lg border p-3 text-xs",
        partial
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "bg-muted/40 text-muted-foreground"
      )}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <FileSearch className="size-3.5" />
        分析依据
      </p>
      <p>
        代码证据：{withEvidence}/{commitCount} 条提交（其中 {withDiff} 条含改动摘录）
        {partial &&
          "。其余提交只按提交信息归纳，常见原因是未配置访问令牌导致限流，或证据拉取超出时间预算"}
      </p>
      <p>
        项目文档：
        {sources.length ? sources.join("、") : "未读取到（仓库无 README/docs，或读取超时）"}
      </p>
    </div>
  );
}
