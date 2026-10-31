import { expect, test } from "vitest";

test("provides the Fetch API URL parser", () => {
  const request = new Request("http://localhost/api/pushes?limit=1");

  expect(new URL(request.url).pathname).toBe("/api/pushes");
});
