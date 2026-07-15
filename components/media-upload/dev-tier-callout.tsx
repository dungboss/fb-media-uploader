import { ExternalLink } from "lucide-react";

import { formatNumber } from "@/lib/media-upload/format";

// Measured pacing (plan.md "Rate-limit ground truth"): dev-tier 15s interval
// → ~240 images/hr. Never derived from Meta's quota formula (active_ads is
// unknown) — this is our own throttle rate, so it's exact, not an estimate.
const DEV_TIER_IMAGES_PER_HOUR = 240;
const TIER_DOCS_URL =
  "https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/";

interface DevTierCalloutProps {
  // Omitted on the compact (ETA-adjacent) repeat — the batch card already
  // shows the count elsewhere.
  imageCount?: number;
  // Compact = the short repeat next to a draining batch's ETA. Full = the
  // pre-commit callout in folder-upload-panel, shown before the user clicks
  // upload. Inform, never gate — this component only ever renders text + a
  // link, no blocking control.
  compact?: boolean;
}

export function DevTierCallout({ imageCount, compact = false }: DevTierCalloutProps) {
  const hours =
    typeof imageCount === "number" ? imageCount / DEV_TIER_IMAGES_PER_HOUR : null;
  const hoursLabel = hours !== null ? (hours < 1 ? "dưới 1 giờ" : `${formatNumber(Math.round(hours))} giờ`) : null;

  if (compact) {
    return (
      <p className="flex flex-wrap items-center gap-1 text-xs text-amber-700">
        Development tier · ~240 ảnh/giờ ·
        <a
          href={TIER_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
        >
          Nâng Standard access nhanh hơn ~75×
          <ExternalLink className="size-3" />
        </a>
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="text-sm font-medium">
        ⚠️ Tài khoản đang ở <strong>Development tier</strong> — khoảng{" "}
        <strong>240 ảnh/giờ</strong>.
      </p>
      <p className="mt-1 text-sm leading-6">
        {hoursLabel ? (
          <>
            {formatNumber(imageCount ?? 0)} ảnh ≈ <strong>{hoursLabel}</strong>.{" "}
          </>
        ) : null}
        Xin cấp <strong>Standard access</strong> để nhanh hơn ~75×.
      </p>
      <a
        href={TIER_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2"
      >
        Hướng dẫn nâng tier
        <ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
