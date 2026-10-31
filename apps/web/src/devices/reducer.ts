import type { DeviceDTO, ServerFrame } from "@pneumo/protocol";

type DeviceFrame = Extract<
  ServerFrame,
  { type: "device_added" | "device_updated" | "device_removed" }
>;
export type DeviceState = {
  devices: DeviceDTO[];
  lastAddedDevice: DeviceDTO | null;
  touched: Set<string>;
};
export const emptyDevices: DeviceState = {
  devices: [],
  lastAddedDevice: null,
  touched: new Set(),
};

type Action =
  | DeviceFrame
  | { type: "clear" }
  | { type: "refresh" }
  | { type: "replace"; devices: DeviceDTO[] };

export function deviceReducer(state: DeviceState, action: Action): DeviceState {
  if (action.type === "clear") return emptyDevices;
  if (action.type === "refresh") return { ...state, touched: new Set() };
  if (action.type === "replace") {
    // A list response must not undo mutations received while it was in flight.
    return {
      ...state,
      devices: [
        ...action.devices.filter((device) => !state.touched.has(device.id)),
        ...state.devices.filter((device) => state.touched.has(device.id)),
      ],
    };
  }
  const id = action.type === "device_removed" ? action.id : action.device.id;
  const touched = new Set(state.touched).add(id);
  const devices = state.devices.filter((device) => device.id !== id);
  if (action.type !== "device_removed") devices.push(action.device);
  return {
    devices,
    touched,
    lastAddedDevice: action.type === "device_added" ? action.device : state.lastAddedDevice,
  };
}
