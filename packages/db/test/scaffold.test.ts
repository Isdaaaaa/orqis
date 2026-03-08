import { describe, expect, it } from "vitest";

import {
  createDefaultSqliteConfig,
  DB_PACKAGE_NAME,
} from "../src/index.ts";

describe("@orqis/db scaffold", () => {
  it("exports a stable package identifier", () => {
    expect(DB_PACKAGE_NAME).toBe("@orqis/db");
  });

  it("returns default sqlite config", () => {
    expect(createDefaultSqliteConfig()).toEqual({ filename: "orqis.db" });
  });
});
