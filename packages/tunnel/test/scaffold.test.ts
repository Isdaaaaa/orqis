import { describe, expect, it } from "vitest";

import {
  createPlaceholderTunnelSession,
  TUNNEL_PACKAGE_NAME,
} from "../src/index.ts";

describe("@orqis/tunnel scaffold", () => {
  it("exports a stable package identifier", () => {
    expect(TUNNEL_PACKAGE_NAME).toBe("@orqis/tunnel");
  });

  it("returns a placeholder tunnel session", () => {
    expect(createPlaceholderTunnelSession()).toEqual({
      provider: "placeholder",
      publicUrl: "https://example.invalid",
    });
  });
});
