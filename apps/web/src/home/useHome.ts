import { decryptPush, encryptPush } from "@pneumo/crypto";
import {
  type DeviceDTO,
  type PushDTO,
  type ServerFrame,
  type UploadMode,
  uuidv7,
} from "@pneumo/protocol";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import { deviceReducer, emptyDevices } from "../devices/reducer.js";
import { type FileActions, type FileSender, useFiles } from "../files/useFiles.js";
import {
  comparePushes,
  emptyHistory,
  type HistoryItem,
  historyReducer,
} from "../history/reducer.js";
import { connectLive, type LiveConnection } from "../live/ws.js";
import type { Session } from "../session/store.js";

type HomeActions = {
  retry: () => void;
  more: () => Promise<void>;
  send: FileSender;
  remove: (id: string) => Promise<void>;
  find: (id: string) => Promise<void>;
  renameDevice: (id: string, name: string) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
};

export type HomeState = HomeActions &
  FileActions & {
    items: HistoryItem[];
    devices: DeviceDTO[];
    lastAddedDevice: DeviceDTO | null;
    maxEnvelopeBytes: number;
    loading: boolean;
    loadingMore: boolean;
    nextBefore: string | null;
    error: string | null;
    live: string;
    offline: boolean;
  };

export function useHome(
  api: ApiClient,
  session: Session | null,
  onUnauthorized: () => void,
): HomeState {
  const [history, dispatch] = useReducer(historyReducer, emptyHistory);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [deviceState, dispatchDevice] = useReducer(deviceReducer, emptyDevices);
  const [maxEnvelopeBytes, setMaxEnvelopeBytes] = useState(0);
  const [maxFileBytes, setMaxFileBytes] = useState(0);
  const [uploadMode, setUploadMode] = useState<UploadMode>("direct");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("connecting");
  const [offline, setOffline] = useState(!navigator.onLine);
  const actions = useRef<HomeActions | null>(null);
  const methods = useMemo<HomeActions>(
    () => ({
      retry: () => actions.current?.retry(),
      more: async () => {
        await actions.current?.more();
      },
      send: async (payload, target, file) => {
        if (!actions.current) throw new Error("Sign in again before sending.");
        await actions.current.send(payload, target, file);
      },
      remove: async (id) => {
        await actions.current?.remove(id);
      },
      find: async (id) => {
        await actions.current?.find(id);
      },
      renameDevice: async (id, name) => {
        if (!actions.current) throw new Error("Sign in again before renaming.");
        await actions.current.renameDevice(id, name);
      },
      removeDevice: async (id) => {
        if (!actions.current) throw new Error("Sign in again before removing.");
        await actions.current.removeDevice(id);
      },
    }),
    [],
  );

  useEffect(() => {
    dispatch({ type: "clear" });
    dispatchDevice({ type: "clear" });
    if (!session) return;
    let active = true;
    let newest: PushDTO | null = null;
    let cursor: string | null = null;
    let before: string | null = null;
    let refreshing: Promise<void> | null = null;
    let paging = false;
    let pushRevision = 0;
    const deleted = new Set<string>();
    let socket: LiveConnection | null = null;
    const abort = new AbortController();
    const signal = abort.signal;
    const remember = (push: PushDTO) => {
      if (deleted.has(push.id)) return;
      if (!newest || comparePushes(push, newest) < 0) {
        newest = push;
        cursor = push.id;
      }
    };
    const decode = async (push: PushDTO): Promise<HistoryItem> => {
      try {
        return {
          ...push,
          payload: await decryptPush(session.contentKey, push.id, push.envelope),
          pending: false,
        };
      } catch {
        return { ...push, payload: null, pending: false };
      }
    };
    const refresh = (): Promise<void> => {
      if (refreshing) return refreshing;
      const startedWith = new Set(historyRef.current.items.map((item) => item.id));
      const selected = new URLSearchParams(window.location.search).get("push");
      if (selected) startedWith.delete(selected);
      const revision = pushRevision;
      dispatchDevice({ type: "refresh" });
      refreshing = (async () => {
        try {
          const [page, listed, me] = await Promise.all([
            api.request("listPushes", { signal }),
            api.request("listDevices", { signal }),
            api.request("me", { signal }),
          ]);
          const items = await Promise.all(page.pushes.map(decode));
          if (!active) return;
          if (revision === pushRevision) {
            newest = null;
            cursor = null;
          }
          for (const push of page.pushes) remember(push);
          dispatch({ type: "replace", items, startedWith });
          dispatchDevice({ type: "replace", devices: listed.devices });
          setMaxEnvelopeBytes(me.limits.maxEnvelopeBytes);
          setMaxFileBytes(me.limits.maxFileBytes);
          setUploadMode(me.uploadMode);
          before = page.nextBefore;
          setNextBefore(before);
          setError(null);
        } catch {
          if (active)
            setError(
              "Could not load your history or devices. Check your connection and try again.",
            );
        } finally {
          refreshing = null;
          if (active) setLoading(false);
        }
      })();
      return refreshing;
    };
    const onFrame = (frame: ServerFrame) => {
      if (!active) return;
      if (frame.type === "push") {
        pushRevision += 1;
        // Advance before decryption: reconnects during replay must not repeat a large batch.
        remember(frame.push);
        void decode(frame.push).then((item) => {
          if (active) dispatch({ type: "merge", items: [item] });
        });
      } else if (frame.type === "push_deleted") {
        deleted.add(frame.id);
        if (newest?.id === frame.id) {
          newest = null;
          cursor = null;
        }
        dispatch({ type: "delete", id: frame.id });
      } else if (frame.type === "device_added" || frame.type === "device_updated") {
        dispatchDevice(frame);
      } else if (frame.type === "device_removed") {
        dispatchDevice(frame);
      } else if (frame.type === "replay_done") {
        setLive("connected");
        // Reconcile missed deletions and the empty-history/hello race as well as replayed pushes.
        void refresh();
      }
    };
    const start = async () => {
      setLoading(true);
      await refresh();
      if (!active || socket) return;
      socket = connectLive({
        token: session.token,
        since: () => cursor,
        onFrame,
        onResync: refresh,
        onUnauthorized,
        onStatus: (status) => {
          if (active) setLive(status);
        },
      });
    };
    actions.current = {
      retry: () => {
        void start();
        socket?.reconnect();
      },
      more: async () => {
        if (refreshing) await refreshing;
        if (!active || paging || !before) return;
        paging = true;
        setLoadingMore(true);
        try {
          const page = await api.request("listPushes", { query: { before }, signal });
          const items = await Promise.all(page.pushes.map(decode));
          if (!active) return;
          dispatch({ type: "merge", items });
          before = page.nextBefore;
          setNextBefore(before);
          setError(null);
        } catch {
          if (active) setError("Could not load older pushes. Try again.");
        } finally {
          paging = false;
          if (active) setLoadingMore(false);
        }
      },
      send: async (payload, targetDeviceId, file) => {
        const id = uuidv7();
        const envelope = await encryptPush(session.contentKey, id, payload);
        const optimistic: HistoryItem = {
          id,
          createdAt: new Date().toISOString(),
          sourceDeviceId: session.deviceId,
          targetDeviceId,
          envelope,
          file: file ?? null,
          payload,
          pending: true,
        };
        if (!active) return;
        dispatch({ type: "merge", items: [optimistic] });
        try {
          const push = await api.request("createPush", {
            body: { id, targetDeviceId, envelope, file: file ? { id: file.id } : null },
            signal,
          });
          if (!active) return;
          remember(push);
          dispatch({ type: "merge", items: [{ ...push, payload, pending: false }] });
        } catch (failure) {
          if (active) dispatch({ type: "rollback", id });
          throw failure;
        }
      },
      remove: async (id) => {
        try {
          await api.request("deletePush", { params: { id }, signal });
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
        }
        if (active) {
          deleted.add(id);
          if (newest?.id === id) {
            newest = null;
            cursor = null;
          }
          dispatch({ type: "delete", id });
        }
      },
      find: async (id) => {
        const push = await api.request("getPush", { params: { id }, signal });
        const item = await decode(push);
        if (active) dispatch({ type: "merge", items: [item] });
      },
      renameDevice: async (id, name) => {
        const device = await api.request("updateDevice", {
          params: { id },
          body: { name },
          signal,
        });
        if (active) dispatchDevice({ type: "device_updated", device });
      },
      removeDevice: async (id) => {
        await api.request("deleteDevice", { params: { id }, signal });
        if (active) dispatchDevice({ type: "device_removed", id });
      },
    };
    const onlineChanged = () => setOffline(!navigator.onLine);
    window.addEventListener("online", onlineChanged);
    window.addEventListener("offline", onlineChanged);
    void start();
    return () => {
      active = false;
      abort.abort();
      socket?.stop();
      actions.current = null;
      window.removeEventListener("online", onlineChanged);
      window.removeEventListener("offline", onlineChanged);
    };
  }, [api, session, onUnauthorized]);

  const files = useFiles({
    api,
    session,
    send: methods.send,
    maxFileBytes,
    maxEnvelopeBytes,
    uploadMode,
    onUnauthorized,
  });

  return {
    items: history.items,
    devices: deviceState.devices,
    lastAddedDevice: deviceState.lastAddedDevice,
    maxEnvelopeBytes,
    loading,
    loadingMore,
    nextBefore,
    error,
    live,
    offline,
    ...methods,
    ...files,
  };
}
