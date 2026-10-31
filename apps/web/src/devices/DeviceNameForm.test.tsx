// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DeviceNameForm } from "./DeviceNameForm.js";

afterEach(cleanup);

test("a failed rename preserves the draft and can be retried without losing edits", async () => {
  const save = vi.fn().mockRejectedValueOnce(new TypeError("Offline")).mockResolvedValue(undefined);
  render(<DeviceNameForm name="Office browser" onSave={save} />);
  const input = screen.getByLabelText("Device name") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Kitchen browser" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("alert");
  expect(input.value).toBe("Kitchen browser");
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("status").textContent).toBe("Device name saved.");
  expect(save).toHaveBeenLastCalledWith("Kitchen browser");
});

test("whitespace cannot erase a device name; remote renames refresh the editor", () => {
  const save = vi.fn();
  const { rerender } = render(<DeviceNameForm name="Office browser" onSave={save} />);
  const input = screen.getByLabelText("Device name") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "   " } });
  expect((screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  rerender(<DeviceNameForm name="Renamed elsewhere" onSave={save} />);
  expect(input.value).toBe("Renamed elsewhere");
});
