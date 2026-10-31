import { isUuidv7, type PushDTO, type PushPayload, WebPushPayload } from "@pneumo/protocol";

const NOTIFICATION_ICON = "/icons/icon-192.png";
const NOTIFICATION_BADGE = "/favicon.svg";

export type PneumoNotificationOptions = NotificationOptions & {
  actions?: { action: string; title: string; icon?: string }[];
};

export type NotificationPresentation = {
  title: string;
  options: PneumoNotificationOptions;
};

export type NotificationSession = {
  contentKey?: CryptoKey | null;
};

export type PushResolutionDependencies = {
  loadSession: () => Promise<NotificationSession | null>;
  fetchPush: (id: string) => Promise<PushDTO>;
  decryptPush: (
    contentKey: CryptoKey,
    pushId: string,
    envelope: PushDTO["envelope"],
  ) => Promise<PushPayload>;
};

function notificationOptions(pushId?: string): PneumoNotificationOptions {
  const options: PneumoNotificationOptions = {
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
  };
  if (pushId !== undefined) {
    options.tag = pushId;
    options.data = { pushId };
  }
  return options;
}

export function genericNotification(pushId?: string): NotificationPresentation {
  return { title: "New push", options: notificationOptions(pushId) };
}

export function notificationForPush(
  pushId: string,
  payload: PushPayload,
): NotificationPresentation {
  const options = notificationOptions(pushId);

  switch (payload.type) {
    case "note":
      options.body = payload.body;
      return { title: payload.title ?? "New note", options };
    case "link":
      options.body = payload.body ?? payload.url;
      options.data = { pushId, url: payload.url };
      options.actions = [{ action: "open", title: "Open link" }];
      return { title: payload.title ?? "New link", options };
    case "file":
      options.body = payload.body ?? payload.file.name;
      return { title: payload.title ?? "New file", options };
  }
}

export async function resolveWebPush(
  input: unknown,
  dependencies: PushResolutionDependencies,
): Promise<NotificationPresentation> {
  const parsed = WebPushPayload.safeParse(input);
  if (!parsed.success) return genericNotification();

  const pushId = parsed.data.t === "push" ? parsed.data.push.id : parsed.data.id;
  try {
    const session = await dependencies.loadSession();
    if (!session?.contentKey) return genericNotification(pushId);

    const push =
      parsed.data.t === "push" ? parsed.data.push : await dependencies.fetchPush(parsed.data.id);
    const payload = await dependencies.decryptPush(session.contentKey, push.id, push.envelope);
    return notificationForPush(push.id, payload);
  } catch {
    return genericNotification(pushId);
  }
}

export type NotificationClickRoute =
  | { type: "open-link"; url: string }
  | { type: "focus-app"; pushId: string | null }
  | { type: "open-app"; url: string };

function notificationData(input: unknown): { pushId: string | null; url: string | null } {
  if (typeof input !== "object" || input === null) return { pushId: null, url: null };
  const value = input as Record<string, unknown>;
  const pushId = isUuidv7(value.pushId) ? value.pushId : null;
  if (typeof value.url !== "string") return { pushId, url: null };

  try {
    const url = new URL(value.url);
    return {
      pushId,
      url: url.protocol === "http:" || url.protocol === "https:" ? url.href : null,
    };
  } catch {
    return { pushId, url: null };
  }
}

export function routeNotificationClick(
  action: string,
  data: unknown,
  hasAppClient: boolean,
): NotificationClickRoute {
  const parsed = notificationData(data);
  if (action === "open" && parsed.url !== null) {
    return { type: "open-link", url: parsed.url };
  }
  if (hasAppClient) return { type: "focus-app", pushId: parsed.pushId };
  return {
    type: "open-app",
    url: parsed.pushId === null ? "/" : `/?push=${encodeURIComponent(parsed.pushId)}`,
  };
}
