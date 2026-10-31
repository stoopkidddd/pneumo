import type { ApiClient } from "../api/client.js";
import { useNotifications } from "../pwa/useNotifications.js";
import { ErrorNotice } from "../views/fields.js";
import "../pwa/pwa.css";

export function BrowserNotifications({ api }: { api: ApiClient }) {
  const notifications = useNotifications(api);
  const { supported, permission, enabled, busy, error } = notifications;
  const denied = permission === "denied";
  return (
    <section className="notification-settings" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <p id="notifications-help" className="muted">
        Receive pushes even when every Pneumo tab is closed. Push content is decrypted only in this
        browser.
      </p>
      <div className="notification-toggle-row">
        <span id="notifications-label">Browser notifications</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="notifications-label"
          aria-describedby="notifications-help notifications-state"
          disabled={busy || !supported || (denied && !enabled)}
          onClick={() => void notifications.toggle()}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
      <p id="notifications-state" className="muted" role="status">
        {!supported
          ? "Browser notifications are not supported in this browser. Use Chrome, Edge or Firefox over HTTPS."
          : busy
            ? "Updating notification settings…"
            : denied
              ? "Notifications are blocked. Allow notifications in your browser’s site settings, then return here."
              : enabled
                ? "Enabled. New pushes will appear as browser notifications."
                : "Off. Enable to receive pushes in this browser."}
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
