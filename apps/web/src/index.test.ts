import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./index.js";

test("renders the Pneumo heading", () => {
  expect(renderToStaticMarkup(createElement(App))).toBe("<main><h1>Pneumo</h1></main>");
});
