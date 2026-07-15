"use client";

import { Loader2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { AdAccount, AdAccountTier } from "@/hooks/use-ad-accounts";

interface AdAccountPickerProps {
  adAccounts: AdAccount[];
  selectedAdAccountId: string;
  isLoadingAdAccounts: boolean;
  onSelect: (adAccountId: string) => void;
}

const TIER_LABEL: Record<AdAccountTier, string> = {
  development_access: "Development tier",
  standard_access: "Standard tier",
  unknown: "Tier chưa xác định",
};

// Ad-account picker + a tier badge for the selected account (locked
// decision: development_access is a warning, standard_access is neutral —
// it's the ~75× faster path, never something to flag).
export function AdAccountPicker({
  adAccounts,
  selectedAdAccountId,
  isLoadingAdAccounts,
  onSelect,
}: AdAccountPickerProps) {
  const selectedAccount = adAccounts.find((account) => account.id === selectedAdAccountId);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="ad-account-select" className="text-xs font-medium text-muted-foreground">
        Tài khoản quảng cáo
      </label>
      <div className="flex items-center gap-2">
        <div className="relative">
          <select
            id="ad-account-select"
            value={selectedAdAccountId}
            onChange={(event) => onSelect(event.target.value)}
            disabled={isLoadingAdAccounts || adAccounts.length === 0}
            className="h-10 w-full min-w-72 appearance-none rounded-xl border border-input bg-white px-3 pr-9 text-sm font-medium shadow-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {isLoadingAdAccounts ? (
              <option value="">Đang tải tài khoản...</option>
            ) : adAccounts.length === 0 ? (
              <option value="">Không có tài khoản khả dụng</option>
            ) : (
              adAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.id})
                  {account.currency ? ` · ${account.currency}` : ""}
                </option>
              ))
            )}
          </select>
          {isLoadingAdAccounts ? (
            <Loader2 className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            <Users className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
        {selectedAccount ? (
          <Badge variant={selectedAccount.tier === "development_access" ? "warning" : "success"}>
            {TIER_LABEL[selectedAccount.tier]}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
