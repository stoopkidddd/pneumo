import { b64uDecode } from "@pneumo/crypto";
import { WebPushSubscription } from "@pneumo/protocol";
import type { ApiClient } from "../api/client.js";

export function notificationsSupported(): boolean {
  return (
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export async function unsubscribeBrowser(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (subscription && !(await subscription.unsubscribe())) {
    throw new Error("Could not unsubscribe this browser.");
  }
}

export async function enableNotifications(api: ApiClient): Promise<boolean> {
  if (!notificationsSupported()) return false;
  // Request permission in the user's click, before waiting for storage or the network.
  if ((await Notification.requestPermission()) !== "granted") return false;
  const [registration, me] = await Promise.all([navigator.serviceWorker.ready, api.request("me")]);
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uDecode(me.vapidPublicKey),
    }));
  try {
    await api.request("subscribeWebPush", {
      body: { subscription: WebPushSubscription.parse(subscription.toJSON()) },
    });
  } catch (failure) {
    if (!existing) await subscription.unsubscribe();
    throw failure;
  }
  return true;
}

export async function disableNotifications(api: ApiClient): Promise<void> {
  await api.request("unsubscribeWebPush");
  await unsubscribeBrowser();
}
