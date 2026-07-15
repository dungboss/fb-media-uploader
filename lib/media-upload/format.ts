// Shared number/size/time formatting for the media-upload UI. Pure
// functions, no node imports — used by hooks and components alike.

const numberFormatter = new Intl.NumberFormat("vi-VN");

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Compact "X giờ Y phút" duration label — no leading "~"/"còn", callers add
// their own prefix so the same helper serves both the drain ETA and a job's
// retry countdown.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 phút";

  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "< 1 phút";
  if (totalMinutes < 60) return `${totalMinutes} phút`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} giờ${minutes ? ` ${minutes} phút` : ""}`;
}

// The batch-card drain ETA — always an estimate, so always tilde-prefixed.
export function formatEta(ms: number): string {
  return `~${formatDuration(ms)}`;
}

// Countdown to an ISO timestamp (a job's nextRetryAt, Meta's cooldown).
// Null once past due — the caller then shows a "sắp thử lại" label instead.
export function formatCountdown(iso: string): string | null {
  const targetMs = new Date(iso).getTime();
  if (!Number.isFinite(targetMs)) return null;

  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return null;

  return `Meta giới hạn — còn ${formatDuration(diffMs)}`;
}
