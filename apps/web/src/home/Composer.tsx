import type { DeviceDTO, PushPayload } from "@pneumo/protocol";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildPushPayload, envelopeByteLength } from "./payload.js";
import "./composer.css";

export interface ComposerProps {
  devices: DeviceDTO[];
  maxEnvelopeBytes: number;
  onSend: (payload: PushPayload, targetDeviceId: string | null) => Promise<void>;
  offline: boolean;
}

type SendState = "idle" | "pending" | "success" | "error";

export function Composer({ devices, maxEnvelopeBytes, onSend, offline }: ComposerProps) {
  const messageId = useId();
  const titleId = useId();
  const targetId = useId();
  const sizeId = useId();
  const limitErrorId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [showTitle, setShowTitle] = useState(false);
  const [targetDeviceId, setTargetDeviceId] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");

  const payload = useMemo(() => buildPushPayload(message, title), [message, title]);
  const envelopeBytes = useMemo(() => envelopeByteLength(payload), [payload]);
  const tooLarge = maxEnvelopeBytes > 0 && envelopeBytes > maxEnvelopeBytes;
  const hasMessage = message.trim().length > 0;
  const unavailable = offline || sendState === "pending";

  // biome-ignore lint/correctness/useExhaustiveDependencies: Measure the DOM after each message edit, including successful draft clearing.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    if (textarea.scrollHeight > 0) {
      textarea.style.height = `${textarea.scrollHeight}px`;
    } else {
      textarea.style.removeProperty("height");
    }
  }, [message]);

  useEffect(() => {
    if (sendState === "success" || sendState === "error") textareaRef.current?.focus();
  }, [sendState]);

  useEffect(() => {
    if (targetDeviceId.length > 0 && !devices.some((device) => device.id === targetDeviceId)) {
      setTargetDeviceId("");
    }
  }, [devices, targetDeviceId]);

  function markEditing() {
    if (sendState !== "idle") setSendState("idle");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unavailable || !hasMessage || tooLarge) return;

    setSendState("pending");
    try {
      await onSend(payload, targetDeviceId.length > 0 ? targetDeviceId : null);
      setMessage("");
      setTitle("");
      setShowTitle(false);
      setSendState("success");
    } catch {
      setSendState("error");
    }
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      composingRef.current
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const sizeDescription = tooLarge ? `${sizeId} ${limitErrorId}` : sizeId;

  return (
    <form className="composer" onSubmit={handleSubmit} aria-busy={sendState === "pending"}>
      <fieldset disabled={unavailable}>
        <div className="composer-field composer-message-field">
          <div className="composer-label-row">
            <label htmlFor={messageId}>Message</label>
            {payload.type === "link" && (
              <span className="composer-kind" role="status">
                Link
              </span>
            )}
          </div>
          <textarea
            ref={textareaRef}
            id={messageId}
            name="message"
            rows={3}
            value={message}
            placeholder="Type a note or paste a link"
            required
            disabled={unavailable}
            aria-invalid={tooLarge}
            aria-describedby={sizeDescription}
            onChange={(event) => {
              setMessage(event.currentTarget.value);
              markEditing();
            }}
            onKeyDown={handleMessageKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
          />
          <p id={sizeId} className="composer-size">
            {envelopeBytes} / {maxEnvelopeBytes} encrypted bytes
          </p>
          {tooLarge && (
            <p id={limitErrorId} className="composer-feedback composer-error" role="alert">
              <svg aria-hidden="true" viewBox="0 0 20 20" className="status-icon">
                <circle cx="10" cy="10" r="8" />
                <path d="M10 5v6m0 3v1" />
              </svg>
              <span>Message is too large. Shorten it and try again.</span>
            </p>
          )}
        </div>

        {showTitle ? (
          <div className="composer-title-group">
            <div className="composer-field">
              <label htmlFor={titleId}>Title</label>
              <input
                id={titleId}
                name="title"
                value={title}
                autoComplete="off"
                disabled={unavailable}
                onChange={(event) => {
                  setTitle(event.currentTarget.value);
                  markEditing();
                }}
              />
            </div>
            <button
              className="text-button composer-title-toggle"
              type="button"
              aria-expanded="true"
              disabled={unavailable}
              onClick={() => {
                setTitle("");
                setShowTitle(false);
                markEditing();
              }}
            >
              Remove title
            </button>
          </div>
        ) : (
          <button
            className="text-button composer-title-toggle"
            type="button"
            aria-expanded="false"
            disabled={unavailable}
            onClick={() => {
              setShowTitle(true);
              markEditing();
            }}
          >
            Add a title
          </button>
        )}

        <div className="composer-actions">
          <div className="composer-field composer-target-field">
            <label htmlFor={targetId}>Send to</label>
            <select
              id={targetId}
              name="targetDeviceId"
              value={targetDeviceId}
              disabled={unavailable}
              onChange={(event) => {
                setTargetDeviceId(event.currentTarget.value);
                markEditing();
              }}
            >
              <option value="">All devices</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} · {device.online ? "online" : "offline"}
                </option>
              ))}
            </select>
          </div>
          <button
            className="primary composer-send"
            type="submit"
            disabled={unavailable || !hasMessage || tooLarge}
          >
            Send
          </button>
        </div>
      </fieldset>

      {sendState === "pending" && (
        <p className="composer-feedback muted" role="status">
          Sending…
        </p>
      )}
      {sendState === "success" && (
        <p className="composer-feedback composer-success" role="status">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="status-icon">
            <circle cx="10" cy="10" r="8" />
            <path d="m6.5 10 2.2 2.2 4.8-5" />
          </svg>
          <span>Sent.</span>
        </p>
      )}
      {sendState === "error" && (
        <p className="composer-feedback composer-error" role="alert">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="status-icon">
            <circle cx="10" cy="10" r="8" />
            <path d="M10 5v6m0 3v1" />
          </svg>
          <span>Could not send. Check your connection and try again.</span>
        </p>
      )}
    </form>
  );
}
