import { Badge } from "@/components/ui/badge";
import type { MediaUploadJobStatus } from "@/lib/media-upload/types";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "success";

const STATUS_INFO: Record<MediaUploadJobStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: "Đang chờ", variant: "outline" },
  processing: { label: "Đang xử lý", variant: "default" },
  completed: { label: "Hoàn tất", variant: "success" },
  failed: { label: "Thất bại", variant: "destructive" },
  cancelled: { label: "Đã huỷ", variant: "secondary" },
};

export function JobStatusBadge({ status }: { status: MediaUploadJobStatus }) {
  const info = STATUS_INFO[status];
  return <Badge variant={info.variant}>{info.label}</Badge>;
}
