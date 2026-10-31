import type { DeviceDTO } from "@pneumo/protocol";
import { useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import type { HomeState } from "../home/useHome.js";
import type { Session } from "../session/store.js";
import { ErrorNotice } from "../views/fields.js";
import { DeviceNameForm } from "./DeviceNameForm.js";
import { PairingModal } from "./PairingModal.js";
import "./devices.css";

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function lastSeen(timestamp: string, now: number): string {
  const age = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (age < 60) return "just now";
  const unit = age < 3600 ? "minute" : age < 86400 ? "hour" : "day";
  return relativeTime.format(
    -Math.floor(age / (unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400)),
    unit,
  );
}

function DeviceRow({
  device,
  self,
  highlighted,
  now,
  onRename,
  onRemove,
}: {
  device: DeviceDTO;
  self: boolean;
  highlighted: boolean;
  now: number;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = useRef<HTMLLIElement>(null);
  const rename = useRef<HTMLButtonElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<"rename" | "remove" | null>(null);
  useEffect(() => {
    if (!highlighted) return;
    row.current?.scrollIntoView({ block: "nearest" });
    row.current?.focus({ preventScroll: true });
  }, [highlighted]);
  useEffect(() => {
    if (confirming) confirmation.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (editing || confirming || !restoreFocus.current) return;
    (restoreFocus.current === "rename" ? rename : remove).current?.focus();
    restoreFocus.current = null;
  }, [editing, confirming]);

  async function removeDevice() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove(device.id);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) {
        setError("Could not remove this device. Check your connection and try again.");
      }
      setBusy(false);
    }
  }

  return (
    <li
      ref={row}
      tabIndex={-1}
      aria-label={device.name}
      className={`device-row${highlighted ? " highlighted" : ""}`}
    >
      <svg className="device-icon" aria-hidden="true" viewBox="0 0 24 24">
        {device.platform === "android" ? (
          <path d="M7 2h10v20H7V2Zm4 17h2M7 5h10" />
        ) : device.platform === "cli" ? (
          <path d="M3 4h18v16H3V4Zm4 5 3 3-3 3m6 0h4" />
        ) : device.platform === "desktop" ? (
          <path d="M3 3h18v13H3V3Zm9 13v5m-5 0h10" />
        ) : (
          <path d="M2 4h20v16H2V4Zm0 5h20M5 6h1m2 0h1" />
        )}
      </svg>
      <div className="device-content">
        <div className="device-title">
          <h2>{device.name}</h2>
          {self && <span className="device-badge">This device</span>}
          {highlighted && <span className="device-new">Newly paired</span>}
        </div>
        <p className="device-meta">
          <span>
            {device.platform === "android"
              ? "Android"
              : device.platform === "cli"
                ? "Command line"
                : device.platform === "desktop"
                  ? "Desktop"
                  : "Browser"}
          </span>
          <span className="device-presence">
            <span aria-hidden="true" className={`device-dot${device.online ? " online" : ""}`} />
            {device.online ? "Online" : "Offline"}
          </span>
          <span>
            Last seen{" "}
            <time dateTime={device.lastSeenAt} title={new Date(device.lastSeenAt).toLocaleString()}>
              {lastSeen(device.lastSeenAt, now)}
            </time>
          </span>
        </p>
        {editing ? (
          <DeviceNameForm
            name={device.name}
            onSave={async (name) => {
              await onRename(device.id, name);
              restoreFocus.current = "rename";
              setEditing(false);
            }}
            onCancel={() => {
              restoreFocus.current = "rename";
              setEditing(false);
            }}
          />
        ) : confirming ? (
          <div className="device-confirmation">
            <p>
              {self
                ? "Remove this browser and sign out? Its local keys will be cleared."
                : `Remove ${device.name}? It will need to pair or sign in again.`}
            </p>
            <div className="device-actions">
              <button
                ref={confirmation}
                type="button"
                className="destructive"
                disabled={busy}
                onClick={() => void removeDevice()}
              >
                Remove device
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  restoreFocus.current = "remove";
                  setConfirming(false);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
            {busy && <p role="status">Removing device…</p>}
          </div>
        ) : null}
        <div className="device-actions" hidden={editing || confirming}>
          <button ref={rename} type="button" onClick={() => setEditing(true)}>
            Rename
          </button>
          <button
            ref={remove}
            type="button"
            className="destructive"
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
      </div>
    </li>
  );
}

export function DevicesView({
  api,
  session,
  state,
  onRemoveSelf,
}: {
  api: ApiClient;
  session: Session;
  state: HomeState;
  onRemoveSelf: () => Promise<void>;
}) {
  const [pairing, setPairing] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const addPhone = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const devices = [...state.devices].sort((a, b) => {
    if (a.id === session.deviceId) return -1;
    if (b.id === session.deviceId) return 1;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
  return (
    <section className="devices-surface" aria-labelledby="devices-title">
      <div className="devices-heading">
        <h1 id="devices-title">Devices</h1>
        <button ref={addPhone} className="primary" type="button" onClick={() => setPairing(true)}>
          Add a phone
        </button>
      </div>
      <p className="muted">Your paired devices. Send to all of them, or choose one on Home.</p>
      {state.offline && <p role="status">You are offline. Device presence may be out of date.</p>}
      {state.error && (
        <>
          <ErrorNotice>{state.error}</ErrorNotice>
          <button type="button" onClick={state.retry}>
            Try again
          </button>
        </>
      )}
      {state.loading && <p role="status">Loading devices…</p>}
      <ul className="device-list" aria-label="Paired devices">
        {devices.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            self={device.id === session.deviceId}
            highlighted={device.id === highlighted}
            now={now}
            onRename={state.renameDevice}
            onRemove={async (id) => {
              if (id === session.deviceId) await onRemoveSelf();
              else {
                await state.removeDevice(id);
                addPhone.current?.focus();
              }
            }}
          />
        ))}
      </ul>
      {!state.loading && !state.error && devices.length === 0 && (
        <p>No paired devices found. Try reloading the list.</p>
      )}
      <p className="sr-only" role="status">
        {highlighted ? "Phone paired. The new device is highlighted." : ""}
      </p>
      {pairing && (
        <PairingModal
          api={api}
          session={session}
          addedDevice={state.lastAddedDevice}
          onClose={() => {
            setPairing(false);
            addPhone.current?.focus();
          }}
          onPaired={(device) => {
            setHighlighted(device.id);
            setPairing(false);
          }}
        />
      )}
    </section>
  );
}
