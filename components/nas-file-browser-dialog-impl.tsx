"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  FileText,
  Folder,
  Loader2,
  RefreshCcw,
  Search,
  Upload,
} from "lucide-react";

import { NasFolderTree } from "@/components/nas-folder-tree";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatWebDavDate,
  formatWebDavSize,
  getWebDavEntryTypeLabel,
  isSupportedWebDavUploadFile,
  normalizeWebDavPath,
  type WebDavDirectoryResponse,
  type WebDavDirectoryEntry,
} from "@/lib/webdav";
import { useWebDavFolderTree } from "@/hooks/use-webdav-folder-tree";

type NasFileSelection = {
  fileName: string;
  nasFilePath: string;
  fileSize: number | null;
};

type NasFileBrowserDialogProps = {
  initialPath?: string;
  isOpen: boolean;
  onClose: () => void;
  onCurrentPathChange?: (path: string) => void;
  onSelectFile: (selection: NasFileSelection) => void;
  // Primary folder-mode action (plan.md: "pick a NAS folder → the server
  // enumerates it", not 5000 checkboxes). Optional so callers that only need
  // single-file selection are unaffected.
  onSelectFolder?: (nasFolderPath: string, imageCount: number) => void;
  rootLabel?: string;
};

export function NasFileBrowserDialog({
  initialPath,
  isOpen,
  onClose,
  onCurrentPathChange,
  onSelectFile,
  onSelectFolder,
  rootLabel = "NAS",
}: NasFileBrowserDialogProps) {
  const {
    breadcrumbs,
    currentDirectory,
    currentPath,
    errorMessage: treeErrorMessage,
    isCurrentDirectoryLoading,
    isInitializing,
    treeRows,
    refreshCurrentDirectory,
    selectPath,
    toggleExpanded,
  } = useWebDavFolderTree({
    fetchDirectory: fetchWebDavDirectory,
    initialPath,
    isOpen,
    rootLabel,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectionErrorMessage, setSelectionErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      setSearchQuery("");
      setSelectedFilePath(null);
      setSelectionErrorMessage(null);
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    onCurrentPathChange?.(currentPath);
  }, [currentPath, isOpen, onCurrentPathChange]);

  const combinedEntries = useMemo(() => {
    const folders = currentDirectory?.folders ?? [];
    const files = (currentDirectory?.files ?? []).filter(isSupportedWebDavUploadFile);
    return [...folders, ...files];
  }, [currentDirectory]);

  // Count of uploadable images directly in the current directory (Depth:1,
  // no recursion — matches the server's PROPFIND enumeration) so the primary
  // folder action can show "N ảnh" before the user commits.
  const currentFolderImageCount = useMemo(
    () => (currentDirectory?.files ?? []).filter(isSupportedWebDavUploadFile).length,
    [currentDirectory]
  );

  const visibleEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return combinedEntries;
    }

    return combinedEntries.filter((entry) =>
      entry.name.toLowerCase().includes(normalizedQuery)
    );
  }, [combinedEntries, searchQuery]);

  const selectedFileEntry = useMemo(
    () =>
      combinedEntries.find(
        (entry) => entry.path === selectedFilePath && !entry.isDirectory
      ) ?? null,
    [combinedEntries, selectedFilePath]
  );

  const combinedErrorMessage = treeErrorMessage || selectionErrorMessage;
  const isBusy = isInitializing;

  function handleNavigatePath(pathValue: string) {
    setSelectedFilePath(null);
    setSelectionErrorMessage(null);
    selectPath(pathValue);
  }

  function handleSelectFile(entry: WebDavDirectoryEntry) {
    if (entry.isDirectory || isBusy) {
      return;
    }

    setSelectedFilePath(entry.path);
    setSelectionErrorMessage(null);
  }

  function handleConfirmSelection() {
    if (!selectedFileEntry) {
      return;
    }

    onSelectFile({
      fileName: selectedFileEntry.name,
      nasFilePath: selectedFileEntry.path,
      fileSize: selectedFileEntry.size ?? null,
    });

    onClose();
  }

  function handleSelectCurrentFolder() {
    if (!onSelectFolder || currentFolderImageCount === 0) {
      return;
    }

    onSelectFolder(currentPath, currentFolderImageCount);
    onClose();
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-7xl overflow-hidden p-0" showCloseButton>
        <div className="flex max-h-[90vh] flex-col">
          <div className="border-b border-border/70 px-6 pt-6 pb-4 pr-12">
            <DialogHeader className="pr-0">
              <DialogTitle>Chọn file từ NAS</DialogTitle>
              <DialogDescription />
            </DialogHeader>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {breadcrumbs.map((item, index) => (
                <button
                  key={item.path}
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    index === breadcrumbs.length - 1
                      ? "border-sky-200 bg-sky-50 text-sky-800"
                      : "border-border bg-background text-muted-foreground hover:border-sky-200 hover:text-foreground"
                  )}
                  onClick={() => handleNavigatePath(item.path)}
                  disabled={isBusy}
                  title={item.path}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-border/70 bg-slate-50/70">
              <NasFolderTree
                rows={treeRows}
                isBusy={isBusy}
                onSelect={handleNavigatePath}
                onToggle={toggleExpanded}
              />
            </aside>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-border/70 px-6 py-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {currentPath}
                  </Badge>
                  <Badge variant="secondary">
                    {currentDirectory
                      ? `${currentDirectory.folders.length} folder${currentDirectory.folders.length === 1 ? "" : "s"}`
                      : "NAS"}
                  </Badge>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {onSelectFolder ? (
                    <Button
                      type="button"
                      onClick={handleSelectCurrentFolder}
                      disabled={isBusy || isCurrentDirectoryLoading || currentFolderImageCount === 0}
                      title={
                        currentFolderImageCount === 0
                          ? "Thư mục này chưa có ảnh (.jpg .jpeg .png .gif)"
                          : undefined
                      }
                    >
                      <Upload className="size-4" />
                      Upload toàn bộ thư mục này ({currentFolderImageCount} ảnh)
                    </Button>
                  ) : null}

                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void refreshCurrentDirectory()}
                    disabled={isBusy || isCurrentDirectoryLoading}
                  >
                    <RefreshCcw className="size-4" />
                    Làm mới
                  </Button>

                  <div className="relative w-full sm:min-w-72">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      className="pl-9"
                      placeholder="Tìm theo tên file hoặc thư mục"
                      disabled={isBusy}
                    />
                  </div>
                </div>
              </div>

              {combinedErrorMessage ? (
                <div className="flex gap-3 border-b border-amber-200 bg-amber-50 px-6 py-3 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-medium">Không thể truy cập NAS</p>
                    <p className="text-sm leading-6">{combinedErrorMessage}</p>
                  </div>
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="overflow-hidden rounded-2xl border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/35">
                        <TableHead>Tên</TableHead>
                        <TableHead className="w-36">Kích thước</TableHead>
                        <TableHead className="w-28">Loại</TableHead>
                        <TableHead className="w-52">Cập nhật</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isCurrentDirectoryLoading && !currentDirectory ? (
                        <TableRow>
                          <TableCell colSpan={4} className="py-12">
                            <div className="flex items-center justify-center gap-3 text-muted-foreground">
                              <Loader2 className="size-4 animate-spin" />
                              Đang đọc nội dung NAS...
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : visibleEntries.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="py-12">
                            <div className="flex flex-col items-center gap-3 text-center">
                              <div className="flex size-12 items-center justify-center rounded-2xl border bg-muted/40">
                                <FileText className="size-5 text-muted-foreground" />
                              </div>
                              <div className="space-y-1">
                                <p className="font-medium">
                                  {searchQuery.trim()
                                    ? "Không có mục nào khớp bộ lọc hiện tại."
                                    : "Thư mục này chưa có file CSV/TXT phù hợp."}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  {searchQuery.trim()
                                    ? "Hãy thử đổi từ khóa hoặc chọn folder khác trong cây bên trái."
                                    : "Hãy mở folder khác trên NAS để tìm file dữ liệu."}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : (
                        visibleEntries.map((entry) => {
                          const isSelected = selectedFileEntry?.path === entry.path;

                          return (
                            <TableRow
                              key={entry.path}
                              data-state={isSelected ? "selected" : undefined}
                              className={cn(
                                "cursor-pointer transition-colors hover:bg-sky-50/40",
                                isSelected && "bg-sky-50/70"
                              )}
                              onClick={() =>
                                entry.isDirectory
                                  ? handleNavigatePath(entry.path)
                                  : handleSelectFile(entry)
                              }
                            >
                              <TableCell className="align-top">
                                <span className="flex min-w-0 items-center gap-3">
                                  <span
                                    className={cn(
                                      "inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
                                      entry.isDirectory
                                        ? "bg-amber-100 text-amber-600"
                                        : "bg-sky-100 text-sky-600"
                                    )}
                                  >
                                    {entry.isDirectory ? (
                                      <Folder className="size-4" fill="currentColor" />
                                    ) : (
                                      <FileText className="size-4" />
                                    )}
                                  </span>
                                  <span className="min-w-0 truncate font-medium text-slate-900">
                                    {entry.name}
                                  </span>
                                </span>
                              </TableCell>
                              <TableCell className="align-top text-muted-foreground">
                                {entry.isDirectory ? "--" : formatWebDavSize(entry.size)}
                              </TableCell>
                              <TableCell className="align-top text-muted-foreground">
                                {getWebDavEntryTypeLabel(entry)}
                              </TableCell>
                              <TableCell className="align-top text-muted-foreground">
                                {formatWebDavDate(entry.lastModified)}
                              </TableCell>
                              <TableCell className="align-top text-right" />
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>

                {selectedFileEntry ? (
                  <div className="mt-4 rounded-2xl border bg-sky-50/60 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="warning">Đã chọn file</Badge>
                      <Badge variant="outline" className="font-mono">
                        {selectedFileEntry.name}
                      </Badge>
                      <Badge variant="secondary">
                        {formatWebDavSize(selectedFileEntry.size)}
                      </Badge>
                    </div>
                    <p className="mt-2 break-all text-sm text-muted-foreground">
                      {selectedFileEntry.path}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border/70 px-6 py-4">
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={onClose}>
                Hủy
              </Button>
              <Button
                type="button"
                onClick={() => handleConfirmSelection()}
                disabled={!selectedFileEntry || isCurrentDirectoryLoading}
              >
                <FileText className="size-4" />
                Chọn file
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function fetchWebDavDirectory(pathValue: string) {
  const response = await fetch(
    `/api/webdav/entries?path=${encodeURIComponent(normalizeWebDavPath(pathValue))}`,
    {
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };

    throw new Error(payload.error || "Không thể đọc thư mục NAS.");
  }

  return (await response.json()) as WebDavDirectoryResponse;
}