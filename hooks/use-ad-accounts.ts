"use client";

import { useEffect, useState } from "react";

import { fetchJson, getErrorMessage } from "@/lib/media-upload/client-fetch";

// Remembers the picked ad account across reloads (per browser).
const AD_ACCOUNT_STORAGE_KEY = "fb-media-uploader:selected-ad-account";

export type AdAccountTier = "development_access" | "standard_access" | "unknown";

export type AdAccount = {
  id: string; // act_<id>
  accountId: string;
  name: string;
  accountStatus: number | null;
  currency: string | null;
  // Free off GET /api/facebook/ad-accounts (the BUC usage header) — no extra
  // Meta call. "unknown" until at least one call for this account recorded usage.
  tier: AdAccountTier;
};

// Loads ad accounts for the active token, mirroring app/page.tsx's original
// bootstrap step 2: picks the remembered account, else the token's default,
// else the first one.
export function useAdAccounts(tokenId: string, isReady: boolean) {
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [selectedAdAccountId, setSelectedAdAccountId] = useState("");
  const [isLoadingAdAccounts, setIsLoadingAdAccounts] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    let isCancelled = false;

    void (async () => {
      setIsLoadingAdAccounts(true);
      try {
        const query = tokenId ? `?tokenId=${encodeURIComponent(tokenId)}` : "";
        const payload = await fetchJson<{
          adAccounts?: AdAccount[];
          defaultAdAccountId?: string | null;
        }>(`/api/facebook/ad-accounts${query}`);
        if (isCancelled) return;

        const accounts = payload.adAccounts ?? [];
        setAdAccounts(accounts);

        const stored =
          typeof window !== "undefined"
            ? window.localStorage.getItem(AD_ACCOUNT_STORAGE_KEY)
            : null;
        const pick =
          (stored && accounts.some((a) => a.id === stored) ? stored : null) ??
          (payload.defaultAdAccountId &&
          accounts.some((a) => a.id === payload.defaultAdAccountId)
            ? payload.defaultAdAccountId
            : null) ??
          accounts[0]?.id ??
          "";

        setSelectedAdAccountId(pick);
        setError(
          pick
            ? null
            : "Token này không truy cập được ad account nào. Kiểm tra quyền ads_management / ads_read."
        );
      } catch (err) {
        if (!isCancelled) {
          setError(getErrorMessage(err, "Không thể tải danh sách ad account từ Meta."));
        }
      } finally {
        if (!isCancelled) setIsLoadingAdAccounts(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [tokenId, isReady]);

  function selectAdAccount(adAccountId: string) {
    if (!adAccountId || adAccountId === selectedAdAccountId) return;
    setSelectedAdAccountId(adAccountId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(AD_ACCOUNT_STORAGE_KEY, adAccountId);
    }
  }

  return { adAccounts, selectedAdAccountId, selectAdAccount, isLoadingAdAccounts, error };
}
