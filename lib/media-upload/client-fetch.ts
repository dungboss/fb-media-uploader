// Shared fetch helper for client hooks talking to the media-upload API.
// Every route in app/api/upload-batches, app/api/upload-jobs, and
// app/api/facebook responds `{ ...payload, error?: string }` on failure —
// this centralizes the "parse JSON, throw on !ok" dance so hooks (4 of them)
// don't each repeat it. No node imports — safe for client components.

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload = await readJsonSafe<T & { error?: string }>(response);

  if (!response.ok) {
    throw new Error(
      (payload as { error?: string }).error || "Không thể kết nối tới server."
    );
  }

  return payload as T;
}

async function readJsonSafe<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
