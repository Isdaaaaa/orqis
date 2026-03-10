import { describe, expect, it, vi } from "vitest";

import {
  createSpecialistAgentAdapterRegistry,
  DuplicateSpecialistAgentAdapterTypeError,
  UnknownSpecialistAgentAdapterTypeError,
  type SpecialistAgentAdapter,
  type SpecialistAgentCapability,
  type SpecialistAgentEnvironmentValidationResult,
  type SpecialistAgentTaskExecutionResult,
} from "../src/index.ts";

const DEFAULT_VALIDATION_RESULT: SpecialistAgentEnvironmentValidationResult = {
  valid: true,
  errors: [],
};

const DEFAULT_CAPABILITIES: readonly SpecialistAgentCapability[] = [
  {
    id: "backend-implementation",
    displayName: "Backend Implementation",
    models: [{ id: "gpt-5" }],
  },
];

const DEFAULT_EXECUTION_RESULT: SpecialistAgentTaskExecutionResult = {
  status: "completed",
  output: "done",
};

function createTestAdapter(
  type: string,
  overrides: Partial<SpecialistAgentAdapter> = {},
): SpecialistAgentAdapter {
  return {
    type,
    validateEnvironment: vi
      .fn()
      .mockResolvedValue(DEFAULT_VALIDATION_RESULT),
    discoverCapabilities: vi.fn().mockResolvedValue(DEFAULT_CAPABILITIES),
    executeTask: vi.fn().mockResolvedValue(DEFAULT_EXECUTION_RESULT),
    ...overrides,
  };
}

describe("specialist agent adapter registry", () => {
  it("routes execution, validation, and capability discovery through a registered adapter", async () => {
    const adapter = createTestAdapter("local_cli");
    const registry = createSpecialistAgentAdapterRegistry([adapter]);

    const validation = await registry.validateEnvironment("local_cli", {
      projectId: "project_1",
      workspaceId: "workspace_1",
      runId: "run_1",
      taskId: "task_1",
      config: { sandbox: true },
    });

    const capabilities = await registry.discoverCapabilities("local_cli", {
      projectId: "project_1",
      workspaceId: "workspace_1",
      runId: "run_1",
    });

    const execution = await registry.executeTask("local_cli", {
      projectId: "project_1",
      workspaceId: "workspace_1",
      runId: "run_1",
      taskId: "task_1",
      payload: { objective: "ship feature" },
    });

    expect(validation).toEqual(DEFAULT_VALIDATION_RESULT);
    expect(capabilities).toEqual(DEFAULT_CAPABILITIES);
    expect(execution).toEqual(DEFAULT_EXECUTION_RESULT);
    expect(adapter.validateEnvironment).toHaveBeenCalledTimes(1);
    expect(adapter.discoverCapabilities).toHaveBeenCalledTimes(1);
    expect(adapter.executeTask).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unknown adapter types during task execution", async () => {
    const registry = createSpecialistAgentAdapterRegistry();

    await expect(
      registry.executeTask("unknown_adapter", {
        projectId: "project_1",
        workspaceId: "workspace_1",
        runId: "run_1",
        taskId: "task_1",
        payload: {},
      }),
    ).rejects.toBeInstanceOf(UnknownSpecialistAgentAdapterTypeError);
  });

  it("rejects duplicate adapter types during registry initialization", () => {
    const adapterA = createTestAdapter("local_cli");
    const adapterB = createTestAdapter("LOCAL_CLI");

    expect(() =>
      createSpecialistAgentAdapterRegistry([adapterA, adapterB]),
    ).toThrow(DuplicateSpecialistAgentAdapterTypeError);
  });
});
