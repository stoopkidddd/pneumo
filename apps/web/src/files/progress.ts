import type { TransferProgress } from "./transfer.js";

export type UploadItem = {
  id: string;
  name: string;
  size: number;
  phase: "encrypting" | "uploading" | "sending" | "error" | "cancelled";
  loaded: number;
  total: number;
  error?: string;
};

export type UploadAction =
  | { type: "add"; item: UploadItem }
  | { type: "progress"; id: string; progress: TransferProgress }
  | { type: "sending"; id: string }
  | { type: "error"; id: string; error: string }
  | { type: "cancel"; id: string }
  | { type: "remove"; id: string };

function isTerminal(item: UploadItem): boolean {
  return item.phase === "cancelled" || item.phase === "error";
}

function updateItem(
  state: UploadItem[],
  id: string,
  update: (item: UploadItem) => UploadItem,
): UploadItem[] {
  let changed = false;
  const next = state.map((item) => {
    if (item.id !== id) return item;
    const updated = update(item);
    if (updated !== item) changed = true;
    return updated;
  });
  return changed ? next : state;
}

export function uploadReducer(state: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case "add":
      return [...state, action.item];
    case "remove": {
      const next = state.filter((item) => item.id !== action.id);
      return next.length === state.length ? state : next;
    }
    case "progress":
      return updateItem(state, action.id, (item) => {
        if (isTerminal(item) || item.phase === "sending") return item;
        const { phase } = action.progress;
        if (phase !== "encrypting" && phase !== "uploading") return item;
        if (item.phase === "uploading" && phase === "encrypting") return item;

        const reportedTotal = Number.isFinite(action.progress.total)
          ? Math.max(0, action.progress.total)
          : 0;
        const reportedLoaded = Number.isFinite(action.progress.loaded)
          ? Math.max(0, action.progress.loaded)
          : 0;
        if (item.phase === phase) {
          const total = Math.max(item.total, reportedTotal);
          const loaded = Math.min(total, Math.max(item.loaded, Math.min(reportedLoaded, total)));
          if (loaded === item.loaded && total === item.total) return item;
          return { ...item, loaded, total };
        }
        const loaded = Math.min(reportedLoaded, reportedTotal);
        return { ...item, phase, loaded, total: reportedTotal };
      });
    case "sending":
      return updateItem(state, action.id, (item) => {
        if (isTerminal(item) || item.phase === "sending") return item;
        return { ...item, phase: "sending" };
      });
    case "error":
      return updateItem(state, action.id, (item) => {
        if (isTerminal(item)) return item;
        return { ...item, phase: "error", error: action.error };
      });
    case "cancel":
      return updateItem(state, action.id, (item) => {
        if (isTerminal(item) || item.phase === "sending") return item;
        return { ...item, phase: "cancelled" };
      });
  }
}
