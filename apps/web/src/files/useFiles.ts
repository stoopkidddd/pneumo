import type { FilePayload, PushPayload, UploadMode } from "@pneumo/protocol";
import { uuidv7 } from "@pneumo/protocol";
import { useEffect, useReducer, useRef } from "react";
import type { ApiClient } from "../api/client.js";
import type { Session } from "../session/store.js";
import { type UploadItem, uploadReducer } from "./progress.js";
import { downloadFile, type TransferProgress, uploadFile, validateFile } from "./transfer.js";

export type FileReference = { id: string; size: number };
export type FileSender = (
  payload: PushPayload,
  target: string | null,
  file?: FileReference,
) => Promise<void>;
export type FileDownloader = (
  fileId: string,
  payload: FilePayload,
  signal: AbortSignal,
  onProgress: (progress: TransferProgress) => void,
) => Promise<void>;
export type FileActions = {
  uploads: UploadItem[];
  sendFiles: (files: File[], body: string, title: string, target: string | null) => void;
  cancelUpload: (id: string) => void;
  dismissUpload: (id: string) => void;
  download: FileDownloader;
};

export function useFiles({
  api,
  session,
  send,
  maxFileBytes,
  maxEnvelopeBytes,
  uploadMode,
  onUnauthorized,
}: {
  api: ApiClient;
  session: Session | null;
  send: FileSender;
  maxFileBytes: number;
  maxEnvelopeBytes: number;
  uploadMode: UploadMode;
  onUnauthorized: () => void;
}): FileActions {
  const [uploads, dispatch] = useReducer(uploadReducer, []);
  const controllers = useRef(new Map<string, AbortController>());
  const currentUploads = useRef(uploads);
  currentUploads.current = uploads;
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A session boundary cancels transfers and removes their local rows.
  useEffect(() => {
    for (const item of currentUploads.current) dispatch({ type: "remove", id: item.id });
    const pending = controllers.current;
    generation.current += 1;
    return () => {
      generation.current += 1;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [session]);

  function sendFiles(files: File[], body: string, title: string, target: string | null) {
    if (!session || maxFileBytes === 0) throw new Error("Wait for your file limits to load.");
    for (const [index, file] of files.entries()) {
      validateFile({
        file,
        body: index === 0 ? body : "",
        title: index === 0 ? title : "",
        maxFileBytes,
        maxEnvelopeBytes,
      });
    }
    const started = generation.current;
    for (const [index, file] of files.entries()) {
      const id = uuidv7();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      dispatch({
        type: "add",
        item: {
          id,
          name: file.name,
          size: file.size,
          phase: "encrypting",
          loaded: 0,
          total: file.size,
        },
      });
      const active = () => generation.current === started && !controller.signal.aborted;
      void (async () => {
        try {
          const uploaded = await uploadFile({
            api,
            token: session.token,
            uploadMode,
            file,
            body: index === 0 ? body : "",
            title: index === 0 ? title : "",
            maxFileBytes,
            maxEnvelopeBytes,
            signal: controller.signal,
            onProgress: (progress) => {
              if (active()) dispatch({ type: "progress", id, progress });
            },
            onUnauthorized,
          });
          if (!active()) return;
          controllers.current.delete(id);
          dispatch({ type: "sending", id });
          await send(uploaded.payload, target, uploaded.file);
          if (active()) dispatch({ type: "remove", id });
        } catch (error) {
          if (active()) {
            dispatch({
              type: "error",
              id,
              error:
                error instanceof Error ? error.message : "Could not send this file. Try again.",
            });
          }
        } finally {
          controllers.current.delete(id);
        }
      })();
    }
  }

  return {
    uploads,
    sendFiles,
    cancelUpload: (id) => {
      const controller = controllers.current.get(id);
      if (!controller) return;
      controller.abort();
      dispatch({ type: "cancel", id });
    },
    dismissUpload: (id) => dispatch({ type: "remove", id }),
    download: async (fileId, payload, signal, onProgress) => {
      if (!session) throw new Error("Sign in again before downloading.");
      await downloadFile({
        api,
        token: session.token,
        uploadMode,
        fileId,
        payload,
        signal,
        onProgress,
        onUnauthorized,
      });
    },
  };
}
