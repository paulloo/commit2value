import { GithubMark } from "@/components/github-mark";
import { ISSUES_URL, REPO_URL } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-12 flex flex-col items-center justify-between gap-3 border-t pt-6 text-xs text-muted-foreground sm:flex-row">
      <p>Commit2Value · 把代码变成客户看得懂的成果汇报</p>
      <div className="flex items-center gap-4">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 hover:text-foreground"
        >
          <GithubMark className="size-3.5" />
          GitHub 开源
        </a>
        <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">
          问题反馈
        </a>
      </div>
    </footer>
  );
}
