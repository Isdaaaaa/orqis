import { describe, expect, it } from "vitest";

import { getWebRuntimeLabel, WEB_PACKAGE_NAME } from "../src/index.ts";

describe("@orqis/web scaffold", () => {
  it("exports a stable package identifier", () => {
    expect(WEB_PACKAGE_NAME).toBe("@orqis/web");
  });

  it("returns a runtime label", () => {
    expect(getWebRuntimeLabel()).toContain("Web runtime");
  });
});
