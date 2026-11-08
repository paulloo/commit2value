"use client";

import { useMemo, useState } from "react";
import { ChevronDown, GitBranch, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  branches: string[];
  defaultBranch: string;
  value: string[];
  max: number;
  onChange: (next: string[]) => void;
}

/**
 * 分支多选。
 *
 * 用弹窗 + 「确定」提交，而不是每勾选一次就生效：
 * 每次变更都会触发重新拉取全部所选分支的提交，逐次生效会产生大量无效请求。
 */
export function BranchMultiSelect({
  branches,
  defaultBranch,
  value,
  max,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(value));
  const [query, setQuery] = useState("");

  // 打开时以当前生效的选择为草稿（在事件中重置，而不是在 effect 里同步 state）
  function openDialog() {
    setDraft(new Set(value));
    setQuery("");
    setOpen(true);
  }

  // 默认分支置顶，其余保持接口返回顺序
  const ordered = useMemo(
    () => [
      ...branches.filter((b) => b === defaultBranch),
      ...branches.filter((b) => b !== defaultBranch),
    ],
    [branches, defaultBranch]
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ordered.filter((b) => b.toLowerCase().includes(q)) : ordered;
  }, [ordered, query]);

  const overLimit = draft.size > max;

  function toggle(b: string) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  }

  const label =
    value.length === 0
      ? "选择分支"
      : value.length === 1
        ? value[0]
        : `${value.length} 个分支`;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        aria-label="选择分支"
        className="relative flex h-8 max-w-56 items-center rounded-md border bg-background pl-8 pr-8 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <span className="truncate">{label}</span>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择分支</DialogTitle>
            <DialogDescription>
              可多选，提交会按 SHA 去重合并。一次最多 {max} 个分支；分支越多请求越多，公开仓库建议在设置中填写 PAT。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索分支"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft((prev) => {
                    const next = new Set(prev);
                    visible.forEach((b) => next.add(b));
                    return next;
                  })
                }
              >
                {query.trim() ? "全选搜索结果" : "全选"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft(new Set())}>
                清空
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft(new Set([defaultBranch]))}
              >
                仅默认分支
              </Button>
              <span
                className={cn(
                  "ml-auto text-muted-foreground",
                  overLimit && "font-medium text-red-600"
                )}
              >
                已选 {draft.size} / 上限 {max}
              </span>
            </div>

            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
              {visible.length === 0 && (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  没有匹配的分支
                </p>
              )}
              {visible.map((b) => (
                <label
                  key={b}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                >
                  <Checkbox checked={draft.has(b)} onCheckedChange={() => toggle(b)} />
                  <span className="truncate">{b}</span>
                  {b === defaultBranch && (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      默认
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              disabled={draft.size === 0 || overLimit}
              onClick={() => {
                // 保持与分支列表一致的顺序，避免同样的集合因顺序不同触发重新拉取
                onChange(ordered.filter((b) => draft.has(b)));
                setOpen(false);
              }}
            >
              {overLimit ? `最多 ${max} 个分支` : "确定"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
