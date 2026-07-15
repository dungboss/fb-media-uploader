"use client";

import type { KeyboardEvent, MouseEvent } from "react";
import { ChevronRight, Folder, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { WebDavFolderTreeRow } from "@/hooks/use-webdav-folder-tree";

type NasFolderTreeProps = {
  rows: WebDavFolderTreeRow[];
  isBusy?: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
};

export function NasFolderTree({
  rows,
  isBusy = false,
  onSelect,
  onToggle,
}: NasFolderTreeProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" || rows.length === 0) {
      return;
    }

    const firstRow = rows[0];
    if (firstRow?.canExpand && !firstRow.isExpanded) {
      event.preventDefault();
      onToggle(firstRow.path);
    }
  };

  const handleContextMenu = (
    event: MouseEvent<HTMLButtonElement>,
    path: string
  ) => {
    event.preventDefault();
    onSelect(path);
  };

  return (
    <div
      className="storage-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      role="tree"
      aria-label="NAS folder tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {isBusy && rows.length === 0 ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/70 text-sm text-slate-500">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            Đang đọc cây folder...
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 text-center text-sm text-slate-500">
          Không có folder nào để hiển thị.
        </div>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => {
            const indentation = 14 + row.depth * 18;

            return (
              <div
                key={row.path}
                role="treeitem"
                aria-expanded={row.canExpand ? row.isExpanded : undefined}
                aria-selected={row.isActive}
                className={cn(
                  "group flex h-10 items-center gap-2 rounded-xl border border-transparent pr-3 text-left transition-colors",
                  row.isActive
                    ? "bg-sky-100 text-sky-900 shadow-[inset_0_0_0_1px_rgba(14,165,233,0.35)]"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                )}
                style={{ paddingLeft: indentation }}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center text-slate-400 transition-colors group-hover:text-slate-700">
                  {row.isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : row.canExpand ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-slate-200/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(row.path);
                      }}
                      aria-label={row.isExpanded ? "Collapse folder" : "Expand folder"}
                    >
                      <span
                        className={cn(
                          "inline-flex transition-transform duration-150",
                          row.isExpanded && "rotate-90"
                        )}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </span>
                    </button>
                  ) : (
                    <span className="h-4 w-4" />
                  )}
                </span>

                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
                  onClick={() => onSelect(row.path)}
                  onContextMenu={(event) => handleContextMenu(event, row.path)}
                  disabled={isBusy}
                >
                  <Folder
                    className="h-4 w-4 shrink-0 text-amber-400"
                    fill="currentColor"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {row.name}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
