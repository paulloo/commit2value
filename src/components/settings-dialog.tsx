"use client";

import { useEffect, useState } from "react";
import { KeyRound, Link2, Bot, GitFork, CalendarRange } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RANGE_DAY_OPTIONS } from "@/lib/limits";
import type { AiSettings } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AiSettings;
  onSave: (s: AiSettings) => void;
}

export function SettingsDialog({ open, onOpenChange, settings, onSave }: Props) {
  const [draft, setDraft] = useState<AiSettings>(settings);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AI 服务设置</DialogTitle>
          <DialogDescription>
            填写任意 OpenAI 兼容服务的接口信息（如 OpenAI、DeepSeek、Moonshot
            等），用于把提交翻译成客户成果汇报。密钥只保存在你的浏览器本地，不会上传到其他服务器。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ai-base-url">
              <Link2 className="size-4 text-muted-foreground" /> API 地址
            </Label>
            <Input
              id="ai-base-url"
              placeholder="https://api.openai.com/v1"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-api-key">
              <KeyRound className="size-4 text-muted-foreground" /> API Key
            </Label>
            <Input
              id="ai-api-key"
              type="password"
              placeholder="sk-..."
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-model">
              <Bot className="size-4 text-muted-foreground" /> 模型
            </Label>
            <Input
              id="ai-model"
              placeholder="gpt-4o-mini / deepseek-chat ..."
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="range-days">
              <CalendarRange className="size-4 text-muted-foreground" /> 统计时间范围
            </Label>
            <select
              id="range-days"
              value={draft.rangeDays ?? 7}
              onChange={(e) =>
                setDraft({ ...draft, rangeDays: Number(e.target.value) })
              }
              className="h-9 w-full rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {RANGE_DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  最近 {d} 天
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              决定读取多少提交用于统计与汇报，周期越长成果越丰富。
            </p>
          </div>

          <div className="my-4 border-t pt-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <GitFork className="size-4 text-muted-foreground" />
              代码平台（私有 / 企业仓库）
            </p>

            {/* 平台切换 */}
            <div className="mb-4 flex gap-2">
              {(["github", "gitlab"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDraft({ ...draft, provider: p })}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    (draft.provider ?? "github") === p
                      ? "border-primary bg-primary/5 text-primary"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {p === "github" ? "GitHub" : "GitLab"}
                </button>
              ))}
            </div>

            {(draft.provider ?? "github") === "github" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="gh-base-url">API 地址</Label>
                  <Input
                    id="gh-base-url"
                    placeholder="https://api.github.com"
                    value={draft.ghBaseUrl ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, ghBaseUrl: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    GitHub Enterprise 请填自托管地址，如
                    https://github.your-company.com/api/v3
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gh-token">
                    <KeyRound className="size-4 text-muted-foreground" /> 访问令牌
                    （PAT，可选）
                  </Label>
                  <Input
                    id="gh-token"
                    type="password"
                    placeholder="ghp_… 不填则只能访问公开仓库"
                    value={draft.ghToken ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, ghToken: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    仅保存在浏览器本地，仅用于读取私有仓库与提升速率限额，不会上传到第三方。{" "}
                    <a
                      href="https://github.com/settings/personal-access-tokens/new"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      前往创建 Fine-grained PAT（只需 Contents 只读权限）↗
                    </a>
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="gl-base-url">API 地址</Label>
                  <Input
                    id="gl-base-url"
                    placeholder="https://gitlab.com/api/v4"
                    value={draft.glBaseUrl ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, glBaseUrl: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    自建 GitLab 请填 https://gitlab.your-company.com/api/v4
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gl-token">
                    <KeyRound className="size-4 text-muted-foreground" /> 访问令牌
                    （PAT）
                  </Label>
                  <Input
                    id="gl-token"
                    type="password"
                    placeholder="glpat-… 需 read_api 权限"
                    value={draft.glToken ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, glToken: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    GitLab 私有项目必须填写令牌。{" "}
                    <a
                      href="https://gitlab.com/-/user_settings/personal_access_tokens"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      前往创建（勾选 read_api）↗
                    </a>
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              onSave({
                baseUrl: draft.baseUrl.trim() || "https://api.openai.com/v1",
                apiKey: draft.apiKey.trim(),
                model: draft.model.trim() || "gpt-4o-mini",
                rangeDays: draft.rangeDays ?? 7,
                provider: draft.provider ?? "github",
                ghBaseUrl: draft.ghBaseUrl?.trim() || undefined,
                ghToken: draft.ghToken?.trim() || undefined,
                glBaseUrl: draft.glBaseUrl?.trim() || undefined,
                glToken: draft.glToken?.trim() || undefined,
                // 估时报价参数在结果区编辑，这里原样保留，避免保存设置时被清掉
                pricing: draft.pricing,
              });
              onOpenChange(false);
            }}
          >
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
