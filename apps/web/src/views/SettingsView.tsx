import type { DeviceDTO } from "@pneumo/protocol";
import { useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import { DeviceNameForm } from "../devices/DeviceNameForm.js";
import { unsubscribeBrowser } from "../pwa/subscription.js";
import { clear } from "../session/store.js";
import { BrowserNotifications } from "../settings/BrowserNotifications.js";
import { ErrorNotice } from "./fields.js";
import "../devices/devices.css";

export function SettingsView({
  api,
  device,
  onRename,
  onSigningOut,
  onSignedOut,
}: {
  api: ApiClient;
  device: DeviceDTO;
  onRename: (name: string) => Promise<void>;
  onSigningOut: (pending: boolean) => void;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    onSigningOut(true);
    try {
      await unsubscribeBrowser();
      await api.request("deleteDevice", { params: { id: device.id } });
      await clear();
      onSignedOut();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return;
      setError("Could not sign out. Check your connection and try again.");
    } finally {
      setBusy(false);
      onSigningOut(false);
    }
  }
  return (
    <section className="settings-surface" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <DeviceNameForm name={device.name} onSave={onRename} />
      <BrowserNotifications api={api} />
      <div className="signout-section">
        <h2>Sign out of this browser</h2>
        <p className="muted">
          Removes this device from your instance and clears its local keys. Sign in with your
          passphrase to connect again.
        </p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button
          type="button"
          className="destructive"
          disabled={busy}
          onClick={() => void signOut()}
        >
          <svg aria-hidden="true" className="status-icon" viewBox="0 0 20 20">
            <path d="M8 3H3v14h5m3-11 4 4-4 4m-5-4h10" />
          </svg>
          Sign out
        </button>
        {busy && <p role="status">Signing out…</p>}
      </div>
    </section>
  );
}
