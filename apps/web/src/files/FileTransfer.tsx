import type { FilePayload } from "@pneumo/protocol";
import { type Ref, useEffect, useId, useRef, useState } from "react";
import { ErrorNotice } from "../views/fields.js";
import type { UploadItem } from "./progress.js";
import { formatBytes, type TransferProgress } from "./transfer.js";
import type { FileDownloader } from "./useFiles.js";
import "./files.css";

export function FileIcon({ image = false }: { image?: boolean }) {
  return (
    <svg className="push-icon" aria-hidden="true" viewBox="0 0 20 20">
      {image ? (
        <>
          <rect x="2" y="2" width="16" height="16" rx="1" />
          <circle cx="7" cy="7" r="1.5" />
          <path d="m3 16 5-5 3 3 3-5 3 7" />
        </>
      ) : (
        <path d="M5 2h7l4 4v12H5V2Zm7 0v5h4M8 11h5m-5 3h5" />
      )}
    </svg>
  );
}

function FileProgress({ progress, name }: { progress: TransferProgress; name: string }) {
  const id = useId();
  const label =
    progress.phase === "encrypting"
      ? "Encrypting"
      : progress.phase === "uploading"
        ? "Uploading"
        : progress.phase === "decrypting"
          ? "Decrypting"
          : "Downloading";
  const percent = progress.total > 0 ? Math.floor((progress.loaded / progress.total) * 100) : 0;
  return (
    <div className="file-progress">
      <span id={id}>
        {label} {percent}%<span className="sr-only">: {name}</span>
      </span>
      <progress aria-labelledby={id} max={Math.max(1, progress.total)} value={progress.loaded} />
    </div>
  );
}

export function UploadRow({
  item,
  onCancel,
  onDismiss,
}: {
  item: UploadItem;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const terminal = item.phase === "error" || item.phase === "cancelled";
  return (
    <article className="history-row" data-upload-id={item.id} aria-label={`File: ${item.name}`}>
      <FileIcon />
      <div className="push-content">
        <p className="file-name">{item.name}</p>
        <p className="file-size muted">{formatBytes(item.size)}</p>
        {item.phase === "encrypting" || item.phase === "uploading" ? (
          <FileProgress progress={{ ...item, phase: item.phase }} name={item.name} />
        ) : (
          <p role="status" className="file-status">
            {item.phase === "sending"
              ? "Sending…"
              : item.phase === "cancelled"
                ? "Upload cancelled. No push was sent."
                : "Upload failed."}
          </p>
        )}
        {item.error && <ErrorNotice>{item.error}</ErrorNotice>}
        <div className="push-actions">
          {terminal ? (
            <button type="button" onClick={() => onDismiss(item.id)}>
              Dismiss
            </button>
          ) : item.phase !== "sending" ? (
            <button type="button" onClick={() => onCancel(item.id)}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function DownloadButton({
  fileId,
  payload,
  onDownload,
  buttonRef,
  disabled,
}: {
  fileId: string;
  payload: FilePayload;
  onDownload: FileDownloader;
  buttonRef?: Ref<HTMLButtonElement>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function download() {
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError(null);
    try {
      await onDownload(fileId, payload, pending.signal, setProgress);
    } catch (failure) {
      if (!pending.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Could not download. Try again.");
      }
    } finally {
      if (!pending.signal.aborted) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  return (
    <div className="file-download">
      <button
        ref={buttonRef}
        type="button"
        disabled={busy || disabled}
        onClick={() => void download()}
      >
        {busy ? "Downloading…" : "Download"}
      </button>
      {progress && <FileProgress progress={progress} name={payload.file.name} />}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}
