import type { DeviceDTO } from "@pneumo/protocol";
import { expect, test } from "vitest";
import { deviceReducer, emptyDevices } from "./reducer.js";

const browser: DeviceDTO = {
  id: "019a3598-c400-7000-8000-000000000001",
  name: "Office browser",
  platform: "web",
  createdAt: "2026-10-31T00:00:00.000Z",
  lastSeenAt: "2026-10-31T00:00:00.000Z",
  online: false,
};
const phone: DeviceDTO = {
  ...browser,
  id: "019a3598-c400-7000-8000-000000000002",
  name: "Phone",
  platform: "android",
};

test("device frames deduplicate additions and replace names, presence and last seen", () => {
  let state = deviceReducer(emptyDevices, { type: "replace", devices: [browser] });
  state = deviceReducer(state, { type: "device_added", device: phone });
  state = deviceReducer(state, { type: "device_added", device: phone });
  const updated = {
    ...phone,
    name: "Pocket phone",
    online: true,
    lastSeenAt: "2026-10-31T12:00:00.000Z",
  };
  state = deviceReducer(state, { type: "device_updated", device: updated });
  expect(state.devices).toEqual([browser, updated]);
  expect(state.lastAddedDevice).toEqual(phone);
  state = deviceReducer(state, { type: "device_removed", id: phone.id });
  expect(state.devices).toEqual([browser]);
});

test("an in-flight list cannot resurrect removals or undo live additions and renames", () => {
  let state = deviceReducer(emptyDevices, { type: "replace", devices: [browser, phone] });
  state = deviceReducer(state, { type: "refresh" });
  state = deviceReducer(state, { type: "device_removed", id: phone.id });
  const renamed = { ...browser, name: "Renamed browser", online: true };
  state = deviceReducer(state, { type: "device_updated", device: renamed });
  const added = { ...phone, id: "019a3598-c400-7000-8000-000000000003" };
  state = deviceReducer(state, { type: "device_added", device: added });
  state = deviceReducer(state, { type: "replace", devices: [browser, phone] });
  expect(state.devices).toEqual([renamed, added]);
  state = deviceReducer(state, { type: "refresh" });
  state = deviceReducer(state, { type: "replace", devices: [renamed] });
  expect(state.devices).toEqual([renamed]);
});

test("list refreshes and updates never announce a new pairing; sign out clears device state", () => {
  let state = deviceReducer(emptyDevices, { type: "replace", devices: [browser, phone] });
  state = deviceReducer(state, { type: "device_updated", device: phone });
  expect(state.lastAddedDevice).toBeNull();
  state = deviceReducer(state, { type: "device_added", device: phone });
  state = deviceReducer(state, { type: "clear" });
  expect(state.devices).toEqual([]);
  expect(state.lastAddedDevice).toBeNull();
});
