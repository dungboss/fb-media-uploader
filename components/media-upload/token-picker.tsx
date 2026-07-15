"use client";

import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AddTokenInput, TokenOption } from "@/hooks/use-fb-tokens";

import { AddTokenDialog } from "./add-token-dialog";

interface TokenPickerProps {
  tokenOptions: TokenOption[];
  selectedTokenId: string;
  hasAnyTokenOption: boolean;
  isLoadingTokens: boolean;
  isAddingToken: boolean;
  deletingTokenId: string | null;
  onSelect: (tokenId: string) => void;
  onAdd: (
    input: AddTokenInput
  ) => Promise<{ token: { id: string; label: string }; adAccountCount: number }>;
  onDelete: (tokenId: string) => Promise<void>;
}

// Header picker for the active Facebook access token + the add/delete
// actions. Extracted unchanged (in behavior) from app/page.tsx's original
// token select + add-token dialog markup.
export function TokenPicker({
  tokenOptions,
  selectedTokenId,
  hasAnyTokenOption,
  isLoadingTokens,
  isAddingToken,
  deletingTokenId,
  onSelect,
  onAdd,
  onDelete,
}: TokenPickerProps) {
  const [isAddOpen, setIsAddOpen] = useState(false);

  async function handleDelete() {
    if (!selectedTokenId) return;
    try {
      await onDelete(selectedTokenId);
      toast.success("Đã xóa access token.");
    } catch (error) {
      toast.error("Xóa token thất bại.", {
        description: error instanceof Error ? error.message : "Không thể xóa access token.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="token-select" className="text-xs font-medium text-muted-foreground">
        Access token
      </label>
      <div className="flex items-center gap-2">
        <div className="relative">
          <select
            id="token-select"
            value={selectedTokenId}
            onChange={(event) => onSelect(event.target.value)}
            disabled={isLoadingTokens || !hasAnyTokenOption}
            className="h-10 w-full min-w-56 appearance-none rounded-xl border border-input bg-white px-3 pr-9 text-sm font-medium shadow-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {isLoadingTokens ? (
              <option value="">Đang tải token...</option>
            ) : !hasAnyTokenOption ? (
              <option value="">Chưa có token</option>
            ) : (
              tokenOptions.map((option) => (
                <option key={option.id || "__env__"} value={option.id}>
                  {option.label}
                </option>
              ))
            )}
          </select>
          {isLoadingTokens ? (
            <Loader2 className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            <KeyRound className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          title="Thêm access token"
          onClick={() => setIsAddOpen(true)}
        >
          <Plus className="size-4" />
        </Button>
        {selectedTokenId ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Xóa token đang chọn"
            onClick={handleDelete}
            disabled={deletingTokenId === selectedTokenId}
          >
            {deletingTokenId === selectedTokenId ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        ) : null}
      </div>

      <AddTokenDialog
        isOpen={isAddOpen}
        isAdding={isAddingToken}
        onOpenChange={setIsAddOpen}
        onAdd={onAdd}
      />
    </div>
  );
}
