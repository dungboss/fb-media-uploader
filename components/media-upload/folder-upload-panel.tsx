"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FolderOpen, Loader2, Upload } from "lucide-react";

import { NasFileBrowserDialog } from "@/components/nas-file-browser-dialog";
import { Button } from "@/components/ui/button";
import type { AdAccount } from "@/hooks/use-ad-accounts";
import type {
  CreateBatchInput,
  CreateBatchResponse,
  CreateLocalBatchInput,
} from "@/hooks/use-upload-batches";
import { formatNumber } from "@/lib/media-upload/format";
import { resolveMediaType } from "@/lib/media-upload/media-type";

import { DevTierCallout } from "./dev-tier-callout";

interface ChosenNasFolder {
  kind: "nas";
  nasFolderPath: string;
  imageCount: number;
}

interface ChosenLocalFolder {
  kind: "local";
  folderName: string;
  imageCount: number;
  files: File[];
}

type ChosenFolder = ChosenNasFolder | ChosenLocalFolder;

interface FolderUploadPanelProps {
  tokenId: string;
  tokenLabel: string;
  hasToken: boolean;
  adAccount: AdAccount | null;
  onCreateBatch: (input: CreateBatchInput) => Promise<CreateBatchResponse>;
  onCreateLocalBatch: (input: CreateLocalBatchInput) => Promise<CreateBatchResponse>;
}

// One folder-level workflow for both NAS and browser-local images. Shows the
// dev-tier callout inline before the user commits (inform, never gate).
export function FolderUploadPanel({
  tokenId,
  tokenLabel,
  hasToken,
  adAccount,
  onCreateBatch,
  onCreateLocalBatch,
}: FolderUploadPanelProps) {
  const localFolderInputRef = useRef<HTMLInputElement>(null);
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [chosenFolder, setChosenFolder] = useState<ChosenFolder | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localUploadProgress, setLocalUploadProgress] = useState<{
    uploaded: number;
    total: number;
  } | null>(null);

  const canSubmit = Boolean(chosenFolder && adAccount && hasToken && !isSubmitting);

  async function handleSubmit() {
    if (!chosenFolder || !adAccount) return;

    setIsSubmitting(true);
    try {
      const common = {
        adAccountId: adAccount.id,
        adAccountName: adAccount.name,
        appName: tokenLabel,
        tokenId,
      };
      const result =
        chosenFolder.kind === "nas"
          ? await onCreateBatch({
              nasFolderPath: chosenFolder.nasFolderPath,
              ...common,
            })
          : await onCreateLocalBatch({
              files: chosenFolder.files,
              folderName: chosenFolder.folderName,
              ...common,
              onProgress: (uploaded, total) =>
                setLocalUploadProgress({ uploaded, total }),
            });

      const folderLabel =
        chosenFolder.kind === "nas"
          ? chosenFolder.nasFolderPath
          : chosenFolder.folderName;

      toast.success("Đã tạo batch upload.", {
        description: `${formatNumber(result.batch.total)} ảnh từ "${folderLabel}" sẽ được xử lý lần lượt.`,
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
      setLocalUploadProgress(null);
    }
  }

  function handleLocalFolderChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    const images = selected.filter(
      (file) => resolveMediaType({ name: file.name, mimeType: file.type }) !== null
    );

    if (images.length === 0) {
      toast.error("Thư mục không có ảnh hỗ trợ (.jpg, .jpeg, .png, .gif).");
      event.target.value = "";
      return;
    }

    const relativePath = images[0].webkitRelativePath;
    const folderName = relativePath.split("/")[0] || "Thư mục local";
    setChosenFolder({ kind: "local", folderName, imageCount: images.length, files: images });

    const skippedCount = selected.length - images.length;
    if (skippedCount > 0) {
      toast.info(`Đã bỏ qua ${formatNumber(skippedCount)} file không phải ảnh hỗ trợ.`);
    }
    event.target.value = "";
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => setIsBrowserOpen(true)}>
          <FolderOpen className="size-4" />
          Duyệt NAS
        </Button>

        <Button
          type="button"
          variant="outline"
          onClick={() => localFolderInputRef.current?.click()}
        >
          <FolderOpen className="size-4" />
          Chọn folder từ máy
        </Button>

        <input
          ref={(element) => {
            localFolderInputRef.current = element;
            element?.setAttribute("webkitdirectory", "");
            element?.setAttribute("directory", "");
          }}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"
          className="hidden"
          onChange={handleLocalFolderChange}
        />

        {chosenFolder ? (
          <div className="rounded-xl border bg-muted/20 px-3 py-2 text-sm">
            <p className="font-medium">
              {chosenFolder.kind === "nas"
                ? chosenFolder.nasFolderPath
                : `Máy tính: ${chosenFolder.folderName}`}
            </p>
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
            {localUploadProgress
              ? `Đang tải lên ${formatNumber(localUploadProgress.uploaded)}/${formatNumber(localUploadProgress.total)}...`
              : "Đang tạo batch..."}
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
          setChosenFolder({ kind: "nas", nasFolderPath, imageCount });
          setIsBrowserOpen(false);
        }}
      />
    </div>
  );
}
