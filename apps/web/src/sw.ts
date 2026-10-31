/// <reference lib="webworker" />

import { b64uDecode, decryptPush } from "@pneumo/crypto";
import { WebPushSubscription } from "@pneumo/protocol";
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { createApiClient } from "./api/client.js";
import { load } from "./session/store.js";
import {
  type NotificationPresentation,
  resolveWebPush,
  routeNotificationClick,
} from "./sw-logic.js";

type PrecacheEntry = string | { url: string; revision?: string; integrity?: string };
type PneumoServiceWorker = ServiceWorkerGlobalScope & {
  __WB_MANIFEST: PrecacheEntry[];
  handlePush: (data: unknown) => Promise<void>;
};
declare const self: PneumoServiceWorker;

const api = createApiClient({ onUnauthorized: async () => undefined });

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api(?:\/|$)/],
  }),
);
clientsClaim();

export async function handlePush(data: unknown): Promise<void> {
  const notification: NotificationPresentation = await resolveWebPush(data, {
    loadSession: load,
    fetchPush: (id) => api.request("getPush", { params: { id } }),
    decryptPush,
  });
  await self.registration.showNotification(notification.title, notification.options);
}

self.handlePush = handlePush;

self.addEventListener("push", (event) => {
  let data: unknown;
  try {
    data = event.data?.json();
  } catch {
    data = undefined;
  }
  event.waitUntil(handlePush(data));
});

function sameOriginWindow(client: WindowClient): boolean {
  try {
    return new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      if (event.action === "open") {
        const linkRoute = routeNotificationClick(event.action, event.notification.data, false);
        if (linkRoute.type === "open-link") {
          await self.clients.openWindow(linkRoute.url);
          return;
        }
      }

      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const appClient = windows.find(sameOriginWindow);
      const route = routeNotificationClick(
        event.action,
        event.notification.data,
        appClient !== undefined,
      );
      if (route.type === "focus-app" && appClient !== undefined) {
        await appClient.focus();
        if (route.pushId !== null) {
          appClient.postMessage({ type: "show-push", id: route.pushId });
        }
        return;
      }
      if (route.type === "open-app") await self.clients.openWindow(route.url);
    })(),
  );
});

async function renewPushSubscription(): Promise<void> {
  const existing = await self.registration.pushManager.getSubscription();
  const session = await load();
  if (!session) {
    if (existing) await existing.unsubscribe();
    return;
  }

  const me = await api.request("me");
  const subscription =
    existing ??
    (await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uDecode(me.vapidPublicKey),
    }));
  try {
    await api.request("subscribeWebPush", {
      body: { subscription: WebPushSubscription.parse(subscription.toJSON()) },
    });
  } catch (failure) {
    const signedOut = await load().then(
      (current) => current === null,
      () => true,
    );
    if (!existing || signedOut) await subscription.unsubscribe().catch(() => false);
    throw failure;
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(renewPushSubscription());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
