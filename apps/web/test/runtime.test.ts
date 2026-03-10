import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startOrqisWebRuntime } from "../src/index.ts";

async function createRuntimeDatabaseFilePath(): Promise<{
  readonly databaseFilePath: string;
  cleanup(): Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-runtime-"));

  return {
    databaseFilePath: join(tempDir, "runtime.db"),
    cleanup: async (): Promise<void> => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe("@orqis/web runtime", () => {
  it(
    "serves a health endpoint and landing page",
    async () => {
      const { databaseFilePath, cleanup } = await createRuntimeDatabaseFilePath();
      const runtime = await startOrqisWebRuntime({
        host: "127.0.0.1",
        port: 0,
        persistence: {
          databaseFilePath,
        },
      });

      try {
        const healthResponse = await fetch(runtime.healthUrl);
        const health = (await healthResponse.json()) as {
          service?: string;
          status?: string;
          uptimeMs?: number;
        };

        expect(healthResponse.status).toBe(200);
        expect(health).toMatchObject({
          service: "@orqis/web",
          status: "ok",
        });
        expect(health.uptimeMs).toBeTypeOf("number");

        const landingResponse = await fetch(runtime.baseUrl);
        const landingPage = await landingResponse.text();

        expect(landingResponse.status).toBe(200);
        expect(landingPage).toContain("Orqis control center");
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    20_000,
  );

  it(
    "returns 404 for unknown routes and can stop twice safely",
    async () => {
      const { databaseFilePath, cleanup } = await createRuntimeDatabaseFilePath();
      const runtime = await startOrqisWebRuntime({
        host: "127.0.0.1",
        port: 0,
        persistence: {
          databaseFilePath,
        },
      });

      try {
        const response = await fetch(`${runtime.baseUrl}/missing`);
        const body = (await response.json()) as { error?: string; path?: string };

        expect(response.status).toBe(404);
        expect(body).toEqual({
          error: "Not Found",
          path: "/missing",
        });
      } finally {
        await runtime.stop();
        await runtime.stop();
        await cleanup();
      }
    },
    20_000,
  );
});
