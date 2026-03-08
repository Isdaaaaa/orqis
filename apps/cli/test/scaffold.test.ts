import { describe, expect, it } from "vitest";

import { CLI_PACKAGE_NAME, getCliBanner } from "../src/index.ts";

describe("@orqis/cli scaffold", () => {
  it("exports a stable package identifier", () => {
    expect(CLI_PACKAGE_NAME).toBe("@orqis/cli");
  });

  it("returns a banner string", () => {
    expect(getCliBanner()).toContain("Orqis CLI");
  });
});
