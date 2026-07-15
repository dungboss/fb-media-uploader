"use client";

import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatNumber } from "@/lib/media-upload/format";
import type { AddTokenInput } from "@/hooks/use-fb-tokens";

const EMPTY_FORM: AddTokenInput = { label: "", token: "", appId: "", appSecret: "" };

interface AddTokenDialogProps {
  isOpen: boolean;
  isAdding: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (
    input: AddTokenInput
  ) => Promise<{ token: { label: string }; adAccountCount: number }>;
}

// The "Thêm access token" dialog — split out of token-picker.tsx purely to
// keep both files under the 200-line guideline.
export function AddTokenDialog({ isOpen, isAdding, onOpenChange, onAdd }: AddTokenDialogProps) {
  const [form, setForm] = useState(EMPTY_FORM);

  function close() {
    onOpenChange(false);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit() {
    const token = form.token.trim();
    if (!token) {
      toast.error("Hãy dán access token.");
      return;
    }

    try {
      const result = await onAdd({ ...form, token });
      toast.success("Đã thêm access token.", {
        description: `${result.token.label} · ${formatNumber(result.adAccountCount)} ad account khả dụng.`,
      });
      close();
    } catch (error) {
      toast.error("Thêm token thất bại.", {
        description: error instanceof Error ? error.message : "Không thể thêm access token.",
      });
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (isAdding) return;
        if (!open) close();
        else onOpenChange(open);
      }}
      disablePointerDismissal={isAdding}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            Thêm Facebook access token
          </DialogTitle>
          <DialogDescription>
            Token (kèm App ID / App Secret) được kiểm tra với Meta rồi mã hóa lưu trên
            server, không lưu trong trình duyệt. Cần quyền ads_management hoặc ads_read.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-5 space-y-5">
          <div className="space-y-3">
            <label className="text-sm font-medium">Nhãn (tùy chọn)</label>
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="VD: BM Công ty A"
              disabled={isAdding}
            />
          </div>
          <div className="space-y-3">
            <label className="text-sm font-medium">Access token</label>
            <Textarea
              value={form.token}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
              placeholder="Dán access token vào đây..."
              disabled={isAdding}
              rows={4}
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-3">
              <label className="text-sm font-medium">App ID (tùy chọn)</label>
              <Input
                value={form.appId}
                onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))}
                placeholder="VD: 1234567890"
                disabled={isAdding}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium">App Secret (tùy chọn)</label>
              <Input
                type="password"
                value={form.appSecret}
                onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))}
                placeholder="Để bật appsecret_proof"
                disabled={isAdding}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            App Secret dùng để tạo appsecret_proof — bắt buộc nếu app bật “Require app
            secret”. Bỏ trống nếu app không yêu cầu.
          </p>
        </div>

        <DialogFooter>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={close} disabled={isAdding}>
              Đóng
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={!form.token.trim() || isAdding}>
              {isAdding ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Đang kiểm tra...
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  Thêm token
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
