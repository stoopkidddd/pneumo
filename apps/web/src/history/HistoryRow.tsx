import type { DeviceDTO } from "@pneumo/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DownloadButton } from "../files/FileTransfer.js";
import { formatBytes } from "../files/transfer.js";
import type { FileDownloader } from "../files/useFiles.js";
import { ErrorNotice } from "../views/fields.js";
import type { HistoryItem } from "./reducer.js";

export function HistoryRow({
  item,
  devices,
  highlighted,
  now,
  onDelete,
  onDownload,
}: {
  item: HistoryItem;
  devices: DeviceDTO[];
  highlighted: boolean;
  now: number;
  onDelete: (id: string) => Promise<void>;
  onDownload: FileDownloader;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = useRef<HTMLElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLParagraphElement>(null);
  const feedback = useRef<number | undefined>(undefined);
  const payload = item.payload;
  const text = payload?.type === "link" ? payload.url : payload?.body;
  const content = payload?.body || text;
  const source =
    devices.find((device) => device.id === item.sourceDeviceId)?.name ?? "Removed device";
  const age = Math.max(0, Math.floor((now - Date.parse(item.createdAt)) / 1000));
  const relative =
    age < 60
      ? "Just now"
      : new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
          -Math.floor(age / (age < 3600 ? 60 : age < 86400 ? 3600 : 86400)),
          age < 3600 ? "minute" : age < 86400 ? "hour" : "day",
        );

  useEffect(() => {
    if (!highlighted) return;
    row.current?.scrollIntoView({ block: "center" });
    (copyButton.current ?? row.current)?.focus({ preventScroll: true });
  }, [highlighted]);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  useEffect(() => () => clearTimeout(feedback.current), []);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(null);
      clearTimeout(feedback.current);
      feedback.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Allow clipboard access, or select and copy the text.");
    }
  }
  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(item.id);
    } catch {
      setError("Could not delete this push. Check your connection and try again.");
      setDeleting(false);
    }
  }

  return (
    <article
      ref={row}
      tabIndex={-1}
      data-push-id={item.id}
      className={`history-row${highlighted ? " highlighted" : ""}`}
      aria-label={
        payload?.title ||
        (payload?.type === "link" ? "Link" : payload?.type === "file" ? "File" : "Note")
      }
    >
      <svg className="push-icon" aria-hidden="true" viewBox="0 0 20 20">
        {payload?.type === "link" ? (
          <path d="m8 12 4-4M7 6l2-2a4 4 0 0 1 6 6l-2 2m-6-4-2 2a4 4 0 0 0 6 6l2-2" />
        ) : payload?.type === "file" && payload.file.mime.startsWith("image/") ? (
          <>
            <rect x="2" y="2" width="16" height="16" rx="1" />
            <circle cx="7" cy="7" r="1.5" />
            <path d="m3 16 5-5 3 3 3-5 3 7" />
          </>
        ) : (
          <path d="M5 2h7l4 4v12H5V2Zm7 0v5h4M8 10h5m-5 4h5" />
        )}
      </svg>
      <div className="push-content">
        <div className="push-meta">
          <span>
            {payload
              ? payload.type === "link"
                ? "Link"
                : payload.type === "file"
                  ? "File"
                  : "Note"
              : "Encrypted push"}
          </span>
          <span>{source}</span>
          <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
            {relative}
          </time>
          {item.pending && <span role="status">Sending…</span>}
          {highlighted && <span className="selected-label">Selected push</span>}
        </div>
        {!payload ? (
          <p className="decrypt-error">Can't decrypt this push</p>
        ) : (
          <>
            {payload.title && <h3>{payload.title}</h3>}
            {payload.type === "file" && (
              <>
                <p className="file-name">{payload.file.name}</p>
                <p className="file-size muted">{formatBytes(payload.file.size)}</p>
              </>
            )}
            {payload.type === "link" && payload.body && (
              <p className="push-body expanded">{payload.url}</p>
            )}
            {content && (
              <p ref={body} className={`push-body${expanded ? " expanded" : ""}`}>
                {content}
              </p>
            )}
            {(clamped || expanded) && (
              <button
                type="button"
                className="text-button expand-button"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </>
        )}
        <div className="push-actions">
          {payload?.type === "file" && item.file && (
            <DownloadButton
              fileId={item.file.id}
              payload={payload}
              onDownload={onDownload}
              buttonRef={copyButton}
              disabled={item.pending}
            />
          )}
          {payload && payload.type !== "file" && (
            <button ref={copyButton} type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {payload?.type === "link" && (
            <a className="open-action" href={payload.url} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          )}
          {!confirming ? (
            <button
              ref={deleteButton}
              type="button"
              className="text-button destructive"
              disabled={item.pending}
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          ) : (
            <div className="delete-confirmation">
              <span>Delete this push?</span>
              <button
                ref={confirmButton}
                type="button"
                className="destructive"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  setConfirming(false);
                  requestAnimationFrame(() => deleteButton.current?.focus());
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        <span className="sr-only" role="status">
          {copied ? "Copied to clipboard" : ""}
        </span>
        {error && <ErrorNotice>{error}</ErrorNotice>}
      </div>
    </article>
  );
}
