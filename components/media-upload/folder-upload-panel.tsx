"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FolderOpen, Loader2, Upload } from "lucide-react";

import { NasFileBrowserDialog } from "@/components/nas-file-browser-dialog";
import { Button } from "@/components/ui/button";
import type { AdAccount } from "@/hooks/use-ad-accounts";
import type { CreateBatchInput, CreateBatchResponse } from "@/hooks/use-upload-batches";
import { formatNumber } from "@/lib/media-upload/format";

import { DevTierCallout } from "./dev-tier-callout";

interface ChosenFolder {
  nasFolderPath: string;
  imageCount: number;
}

interface FolderUploadPanelProps {
  tokenId: string;
  tokenLabel: string;
  hasToken: boolean;
  adAccount: AdAccount | null;
  onCreateBatch: (input: CreateBatchInput) => Promise<CreateBatchResponse>;
}

// Primary UX per plan.md: pick a NAS FOLDER, the server enumerates it — not
// 5000 checkboxes. Shows the dev-tier callout inline before the user commits
// (inform, never gate).
export function FolderUploadPanel({
  tokenId,
  tokenLabel,
  hasToken,
  adAccount,
  onCreateBatch,
}: FolderUploadPanelProps) {
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [chosenFolder, setChosenFolder] = useState<ChosenFolder | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = Boolean(chosenFolder && adAccount && hasToken && !isSubmitting);

  async function handleSubmit() {
    if (!chosenFolder || !adAccount) return;

    setIsSubmitting(true);
    try {
      const result = await onCreateBatch({
        nasFolderPath: chosenFolder.nasFolderPath,
        adAccountId: adAccount.id,
        adAccountName: adAccount.name,
        appName: tokenLabel,
        tokenId,
      });

      toast.success("Đã tạo batch upload.", {
        description: `${formatNumber(result.batch.total)} ảnh từ "${chosenFolder.nasFolderPath}" sẽ được xử lý lần lượt.`,
      });

      if (result.skipped.length > 0) {
        const reasons = result.skipped.slice(0, 3).map((s) => s.reason);
        toast.warning(`${formatNumber(result.skipped.length)} file bị bỏ qua.`, {
          description: reasons.join(" · "),
        });
      }

      setChosenFolder(null);
    } catch (error) {
      toast.error("Tạo batch thất bại.", {
        description: error instanceof Error ? error.message : "Không thể tạo batch upload.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => setIsBrowserOpen(true)}>
          <FolderOpen className="size-4" />
          {chosenFolder ? "Đổi thư mục khác" : "Duyệt NAS"}
        </Button>

        {chosenFolder ? (
          <div className="rounded-xl border bg-muted/20 px-3 py-2 text-sm">
            <p className="font-medium">{chosenFolder.nasFolderPath}</p>
            <p className="text-xs text-muted-foreground">
              {formatNumber(chosenFolder.imageCount)} ảnh
            </p>
          </div>
        ) : null}
      </div>

      {chosenFolder && adAccount?.tier === "development_access" ? (
        <DevTierCallout imageCount={chosenFolder.imageCount} />
      ) : null}

      <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
        {isSubmitting ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Đang tạo batch...
          </>
        ) : (
          <>
            <Upload className="size-4" />
            Upload thư mục này
          </>
        )}
      </Button>

      <NasFileBrowserDialog
        isOpen={isBrowserOpen}
        onClose={() => setIsBrowserOpen(false)}
        onSelectFile={() => {}}
        onSelectFolder={(nasFolderPath, imageCount) => {
          setChosenFolder({ nasFolderPath, imageCount });
          setIsBrowserOpen(false);
        }}
      />
    </div>
  );
}
