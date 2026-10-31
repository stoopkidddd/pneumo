import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import {
  disableNotifications,
  enableNotifications,
  notificationsSupported,
} from "./subscription.js";

export function useNotifications(api: ApiClient) {
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(supported);
  const [error, setError] = useState<string | null>(null);
  const changing = useRef(false);
  const refresh = useCallback(async () => {
    if (!supported || changing.current) return;
    setPermission(Notification.permission);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      setEnabled(Boolean(await registration?.pushManager.getSubscription()));
      setError(null);
    } catch {
      setError("Could not read notification settings. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  async function toggle() {
    if (busy || changing.current || !supported) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await disableNotifications(api);
        setEnabled(false);
      } else {
        setEnabled(await enableNotifications(api));
      }
      setPermission(Notification.permission);
    } catch {
      setError("Could not change browser notifications. Check your connection and try again.");
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  return { supported, permission, enabled, busy, error, toggle };
}
