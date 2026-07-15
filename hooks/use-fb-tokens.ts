"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchJson, getErrorMessage } from "@/lib/media-upload/client-fetch";

// Remembers the picked access token id across reloads ("" = the .env
// fallback token). Renamed from the audience-era key — a one-time reset of
// this browser-local preference is harmless.
const TOKEN_STORAGE_KEY = "fb-media-uploader:selected-token";

export type FbToken = {
  id: string;
  label: string;
  appId: string | null;
  createdAt: string;
  lastValidatedAt: string | null;
};

// One option in the token picker. The empty-id entry represents the .env token.
export type TokenOption = { id: string; label: string };

export interface AddTokenInput {
  label: string;
  token: string;
  appId: string;
  appSecret: string;
}

// Bootstraps the token list, remembers the active pick in localStorage, and
// exposes add/delete mutations. Mirrors app/page.tsx's original bootstrap
// step 1 + token add/delete handlers, extracted unchanged in behavior.
export function useFbTokens() {
  const [tokens, setTokens] = useState<FbToken[]>([]);
  const [hasEnvToken, setHasEnvToken] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const [tokensReady, setTokensReady] = useState(false);
  const [isLoadingTokens, setIsLoadingTokens] = useState(true);
  const [isAddingToken, setIsAddingToken] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokenOptions: TokenOption[] = [
    ...(hasEnvToken ? [{ id: "", label: "Token mặc định (.env)" }] : []),
    ...tokens.map((token) => ({
      id: token.id,
      label: token.appId ? `${token.label} · App ${token.appId}` : token.label,
    })),
  ];
  const hasAnyTokenOption = tokenOptions.length > 0;

  const reload = useCallback(async () => {
    const payload = await fetchJson<{ tokens?: FbToken[]; hasEnvToken?: boolean }>(
      "/api/facebook/tokens"
    );
    const nextTokens = payload.tokens ?? [];
    const envToken = Boolean(payload.hasEnvToken);
    setTokens(nextTokens);
    setHasEnvToken(envToken);
    return { tokens: nextTokens, hasEnvToken: envToken };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      setIsLoadingTokens(true);
      try {
        const { tokens: nextTokens, hasEnvToken: envToken } = await reload();
        if (isCancelled) return;

        const optionIds = [...(envToken ? [""] : []), ...nextTokens.map((t) => t.id)];
        const stored =
          typeof window !== "undefined"
            ? window.localStorage.getItem(TOKEN_STORAGE_KEY)
            : null;
        const pick =
          stored !== null && optionIds.includes(stored)
            ? stored
            : envToken
              ? ""
              : (nextTokens[0]?.id ?? "");

        setSelectedTokenId(pick);
        setTokensReady(true);
        setError(
          optionIds.length === 0
            ? "Chưa có access token nào. Hãy bấm “Thêm token” để kết nối Meta."
            : null
        );
      } catch (err) {
        if (!isCancelled) {
          setError(getErrorMessage(err, "Không thể tải danh sách access token."));
        }
      } finally {
        if (!isCancelled) setIsLoadingTokens(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [reload]);

  function selectToken(tokenId: string) {
    if (tokenId === selectedTokenId) return;
    setSelectedTokenId(tokenId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, tokenId);
    }
  }

  async function addToken(input: AddTokenInput) {
    setIsAddingToken(true);
    try {
      const payload = await fetchJson<{ token?: FbToken; adAccountCount?: number }>(
        "/api/facebook/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      if (!payload.token) {
        throw new Error("Không thể thêm access token.");
      }

      const { tokens: nextTokens, hasEnvToken: envToken } = await reload();
      setTokens(nextTokens);
      setHasEnvToken(envToken);
      selectToken(payload.token.id);

      return { token: payload.token, adAccountCount: payload.adAccountCount ?? 0 };
    } finally {
      setIsAddingToken(false);
    }
  }

  async function deleteToken(tokenId: string) {
    if (!tokenId) return;

    setDeletingTokenId(tokenId);
    try {
      const payload = await fetchJson<{ deleted?: boolean }>(
        `/api/facebook/tokens/${tokenId}`,
        { method: "DELETE" }
      );
      if (!payload.deleted) {
        throw new Error("Không thể xóa access token.");
      }

      const { tokens: nextTokens, hasEnvToken: envToken } = await reload();
      if (selectedTokenId === tokenId) {
        selectToken(envToken ? "" : (nextTokens[0]?.id ?? ""));
      }
    } finally {
      setDeletingTokenId(null);
    }
  }

  return {
    tokens,
    hasEnvToken,
    selectedTokenId,
    tokensReady,
    isLoadingTokens,
    tokenOptions,
    hasAnyTokenOption,
    isAddingToken,
    deletingTokenId,
    error,
    selectToken,
    addToken,
    deleteToken,
  };
}
