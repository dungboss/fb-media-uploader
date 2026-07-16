import { ExternalLink } from "lucide-react";

import { formatNumber } from "@/lib/media-upload/format";

// NO RATE CLAIM HERE — deliberately. This component used to promise "~240
// ảnh/giờ" and turn it into an ETA ("5000 ảnh ≈ 21 giờ"). Both numbers came
// from the fixed 15s throttle that no longer exists (see BURST MODE in
// workers/media-upload-worker.ts). They were never Meta's limit either: dev
// quota is `300 + 40 × active_ads` calls/hr and `active_ads` is unknown to us,
// so any images/hr figure printed here would be an invention.
//
// The batch card already shows an ETA computed from OBSERVED throughput
// (plan.md: "ETA is computed from observed throughput, never from the
// formula"). That is the honest number; this callout only explains the tier
// and points at the one lever that actually moves it.
const TIER_DOCS_URL =
  "https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/";

interface DevTierCalloutProps {
  // Shown only in the full variant, purely to name the batch size back to the
  // operator — never multiplied into a duration.
  imageCount?: number;
  // Compact = the short repeat next to a draining batch's ETA. Full = the
  // pre-commit callout in folder-upload-panel, shown before the user clicks
  // upload. Inform, never gate — this component only ever renders text + a
  // link, no blocking control.
  compact?: boolean;
}

export function DevTierCallout({ imageCount, compact = false }: DevTierCalloutProps) {
  if (compact) {
    return (
      <p className="flex flex-wrap items-center gap-1 text-xs text-amber-700">
        Development tier · quota thấp, sẽ tự nghỉ khi Meta chặn ·
        <a
          href={TIER_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
        >
          Nâng Standard access để nhanh hơn nhiều lần
          <ExternalLink className="size-3" />
        </a>
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="text-sm font-medium">
        ⚠️ Tài khoản đang ở <strong>Development tier</strong> — quota thấp hơn nhiều lần.
      </p>
      <p className="mt-1 text-sm leading-6">
        {typeof imageCount === "number" ? (
          <>
            {formatNumber(imageCount)} ảnh sẽ được upload hết tốc lực.{" "}
          </>
        ) : null}
        Khi Meta báo chạm giới hạn, worker tự nghỉ rồi chạy tiếp — không ảnh nào bị mất.
        Tốc độ thật phụ thuộc quota của tài khoản, ETA sẽ hiện sau khi chạy được một lúc.
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
