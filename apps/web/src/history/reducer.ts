import type { PushDTO, PushPayload } from "@pneumo/protocol";

export type HistoryItem = PushDTO & { payload: PushPayload | null; pending: boolean };
export type HistoryState = { items: HistoryItem[]; deleted: ReadonlySet<string> };
export const emptyHistory: HistoryState = { items: [], deleted: new Set() };
export type HistoryAction =
  | { type: "merge"; items: HistoryItem[] }
  | { type: "replace"; items: HistoryItem[]; startedWith: ReadonlySet<string> }
  | { type: "delete"; id: string }
  | { type: "rollback"; id: string }
  | { type: "clear" };

export function comparePushes(a: PushDTO, b: PushDTO): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === "clear") return emptyHistory;
  if (action.type === "delete" || action.type === "rollback") {
    return {
      items: state.items.filter((item) => item.id !== action.id),
      deleted: action.type === "delete" ? new Set([...state.deleted, action.id]) : state.deleted,
    };
  }
  const items = new Map<string, HistoryItem>();
  for (const item of state.items) {
    if (action.type === "merge" || item.pending || !action.startedWith.has(item.id)) {
      items.set(item.id, item);
    }
  }
  for (const item of action.items) {
    if (state.deleted.has(item.id)) continue;
    const previous = items.get(item.id);
    if (!item.pending || !previous || previous.pending) items.set(item.id, item);
  }
  return { items: [...items.values()].sort(comparePushes), deleted: state.deleted };
}
