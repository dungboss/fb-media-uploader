"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AdAccountPicker } from "@/components/media-upload/ad-account-picker";
import { BatchesList } from "@/components/media-upload/batches-list";
import { BatchJobsDialog } from "@/components/media-upload/batch-jobs-dialog";
import { FolderUploadPanel } from "@/components/media-upload/folder-upload-panel";
import { TokenPicker } from "@/components/media-upload/token-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdAccounts } from "@/hooks/use-ad-accounts";
import { useFbTokens } from "@/hooks/use-fb-tokens";
import { useUploadBatches } from "@/hooks/use-upload-batches";

// Composition root only — every stateful concern lives in a hook, every
// rendered surface lives in components/media-upload/*. See
// plans/260716-0010-nas-images-to-fb-media-library/phase-05-ui-rewrite.md.
export default function Home() {
  const fbTokens = useFbTokens();
  const adAccounts = useAdAccounts(fbTokens.selectedTokenId, fbTokens.tokensReady);
  const uploadBatches = useUploadBatches();

  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [retryingBatchId, setRetryingBatchId] = useState<string | null>(null);
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);

  const selectedAccount =
    adAccounts.adAccounts.find((account) => account.id === adAccounts.selectedAdAccountId) ??
    null;
  const selectedTokenLabel =
    fbTokens.tokens.find((token) => token.id === fbTokens.selectedTokenId)?.label ??
    "Token mặc định (.env)";
  const openBatchEntry =
    uploadBatches.entries.find((entry) => entry.batch.id === openBatchId) ?? null;

  async function handleRetryFailed(batchId: string) {
    setRetryingBatchId(batchId);
    try {
      const retried = await uploadBatches.retryFailed(batchId);
      toast.success(`Đã thử lại ${retried} job lỗi.`);
    } catch (error) {
      toast.error("Thử lại thất bại.", {
        description:
          error instanceof Error ? error.message : "Không thể thử lại các job lỗi.",
      });
    } finally {
      setRetryingBatchId(null);
    }
  }

  async function handleDeleteBatch(batchId: string) {
    setDeletingBatchId(batchId);
    try {
      await uploadBatches.deleteBatch(batchId);
      if (openBatchId === batchId) setOpenBatchId(null);
      toast.success("Đã xoá batch.");
    } catch (error) {
      toast.error("Xoá batch thất bại.", {
        description: error instanceof Error ? error.message : "Không thể xoá batch.",
      });
    } finally {
      setDeletingBatchId(null);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-sky-50/40 p-6">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Facebook Media Uploader
          </h1>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <TokenPicker
              tokenOptions={fbTokens.tokenOptions}
              selectedTokenId={fbTokens.selectedTokenId}
              hasAnyTokenOption={fbTokens.hasAnyTokenOption}
              isLoadingTokens={fbTokens.isLoadingTokens}
              isAddingToken={fbTokens.isAddingToken}
              deletingTokenId={fbTokens.deletingTokenId}
              onSelect={fbTokens.selectToken}
              onAdd={fbTokens.addToken}
              onDelete={fbTokens.deleteToken}
            />
            <AdAccountPicker
              adAccounts={adAccounts.adAccounts}
              selectedAdAccountId={adAccounts.selectedAdAccountId}
              isLoadingAdAccounts={adAccounts.isLoadingAdAccounts}
              onSelect={adAccounts.selectAdAccount}
            />
          </div>
        </header>

        {fbTokens.error || adAccounts.error ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {fbTokens.error || adAccounts.error}
          </p>
        ) : null}

        <Card className="rounded-[28px] border-white/60 bg-white/85 shadow-lg shadow-slate-950/5 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-lg">Upload ảnh từ NAS</CardTitle>
          </CardHeader>
          <CardContent>
            <FolderUploadPanel
              tokenId={fbTokens.selectedTokenId}
              tokenLabel={selectedTokenLabel}
              hasToken={fbTokens.hasAnyTokenOption}
              adAccount={selectedAccount}
              onCreateBatch={uploadBatches.createFromFolder}
            />
          </CardContent>
        </Card>

        <BatchesList
          entries={uploadBatches.entries}
          isLoading={uploadBatches.isLoading}
          error={uploadBatches.error}
          adAccounts={adAccounts.adAccounts}
          nowMs={uploadBatches.lastSyncedAt}
          retryingBatchId={retryingBatchId}
          deletingBatchId={deletingBatchId}
          onOpenJobs={setOpenBatchId}
          onRetryFailed={handleRetryFailed}
          onDelete={handleDeleteBatch}
        />
      </div>

      <BatchJobsDialog
        batchId={openBatchId}
        batchLabel={openBatchEntry?.batch.nasFolderPath ?? null}
        onClose={() => setOpenBatchId(null)}
        onJobRetried={uploadBatches.refresh}
      />
    </div>
  );
}
