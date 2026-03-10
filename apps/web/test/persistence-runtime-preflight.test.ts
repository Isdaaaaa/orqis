import { describe, expect, it } from "vitest";

import {
  validateWorkspaceTimelinePersistenceRuntime,
  WorkspaceTimelineDependencyError,
} from "../src/persistence.ts";

describe("@orqis/web sqlite runtime preflight", () => {
  it("returns an actionable dependency error when native bindings are unavailable", () => {
    let thrown: unknown;

    try {
      validateWorkspaceTimelinePersistenceRuntime(() => {
        throw new Error("Could not locate the bindings file");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkspaceTimelineDependencyError);

    const dependencyError = thrown as WorkspaceTimelineDependencyError;
    expect(dependencyError.code).toBe("ERR_ORQIS_SQLITE_BINDINGS_UNAVAILABLE");
    expect(dependencyError.message).toContain(
      "pnpm run orqis:web:sqlite:bootstrap",
    );
    expect(dependencyError.message).toContain("pnpm run orqis:web:sqlite:doctor");
  });

  it("passes through non-binding preflight errors", () => {
    expect(() =>
      validateWorkspaceTimelinePersistenceRuntime(() => {
        throw new Error("Permission denied");
      }),
    ).toThrowError("Permission denied");
  });
});
