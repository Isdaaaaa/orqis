import { describe, expect, it } from "vitest";

import {
  CORE_PACKAGE_NAME,
  createInitialRunStatus,
  type RunStatus,
} from "../src/index.ts";

describe("@orqis/core scaffold", () => {
  it("exports a stable package identifier", () => {
    expect(CORE_PACKAGE_NAME).toBe("@orqis/core");
  });

  it("returns a valid initial run status", () => {
    const status: RunStatus = createInitialRunStatus();
    expect(status).toBe("planned");
  });
});
