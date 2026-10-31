import { useState } from "react";
import type { ApiClient } from "../api/client.js";
import { Link } from "../Link.js";
import { ErrorNotice } from "../views/fields.js";
import { useNotifications } from "./useNotifications.js";
import "./pwa.css";

const PROMPT_KEY = "pneumo-notification-prompt-seen";

function alreadySeen(): boolean {
  try {
    return localStorage.getItem(PROMPT_KEY) === "true";
  } catch {
    return false;
  }
}

export function NotificationPrompt({ api }: { api: ApiClient }) {
  const [dismissed, setDismissed] = useState(alreadySeen);
  const notifications = useNotifications(api);
  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(PROMPT_KEY, "true");
    } catch {
      // The prompt still dismisses for this visit when browser storage is blocked.
    }
  }
  if (
    dismissed ||
    !notifications.supported ||
    notifications.busy ||
    notifications.enabled ||
    notifications.permission !== "default"
  )
    return null;
  return (
    <section className="notification-prompt" aria-labelledby="notification-prompt-title">
      <h2 id="notification-prompt-title">Get notified in this browser</h2>
      <p className="muted">
        See new pushes when Pneumo is closed. You can change this in Settings.
      </p>
      <div className="pwa-actions">
        <button type="button" onClick={() => void notifications.toggle()}>
          Enable notifications
        </button>
        <button type="button" onClick={dismiss}>
          Not now
        </button>
        <Link href="/settings">Notification settings</Link>
      </div>
      {notifications.error && <ErrorNotice>{notifications.error}</ErrorNotice>}
    </section>
  );
}
