// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Link } from "./Link.js";

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(cleanup);

test("an internal link pushes a route without replacing the current history entry", () => {
  const length = window.history.length;
  render(<Link href="/devices?view=all">Devices</Link>);
  const prevented = !fireEvent.click(screen.getByRole("link", { name: "Devices" }));
  expect(prevented).toBe(true);
  expect(window.location.pathname).toBe("/devices");
  expect(window.location.search).toBe("?view=all");
  expect(window.history.length).toBe(length + 1);
});

test.each([
  { name: "control-click", event: { ctrlKey: true } },
  { name: "command-click", event: { metaKey: true } },
  { name: "shift-click", event: { shiftKey: true } },
  { name: "alt-click", event: { altKey: true } },
  { name: "non-primary click", event: { button: 1 } },
  { name: "new-tab target", event: {}, target: "_blank" },
  { name: "download", event: {}, download: "notes" },
  { name: "external origin", event: {}, href: "https://example.test/devices" },
])(
  "$name retains the browser's native navigation behavior",
  ({ event, target, download, href }) => {
    render(
      <Link
        href={href ?? "/devices"}
        {...(target ? { target } : {})}
        {...(download ? { download } : {})}
      >
        Devices
      </Link>,
    );
    let nativeNavigation = false;
    const observeDefault = (click: MouseEvent) => {
      nativeNavigation = !click.defaultPrevented;
      click.preventDefault();
    };
    document.addEventListener("click", observeDefault, { once: true });
    fireEvent.click(screen.getByRole("link", { name: "Devices" }), event);
    expect(nativeNavigation).toBe(true);
    expect(window.location.pathname).toBe("/");
  },
);
