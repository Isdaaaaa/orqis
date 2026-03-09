import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isWebRuntimeProcessEntrypoint,
  resolveRuntimeProcessConfig,
} from "../src/runtime-process.ts";

describe("@orqis/web runtime process", () => {
  it("resolves runtime host and port from environment variables", () => {
    expect(
      resolveRuntimeProcessConfig({
        ORQIS_WEB_RUNTIME_HOST: "127.0.0.1",
        ORQIS_WEB_RUNTIME_PORT: "43110",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 43110,
    });
  });

  it("fails fast when host is missing", () => {
    expect(() =>
      resolveRuntimeProcessConfig({
        ORQIS_WEB_RUNTIME_PORT: "43110",
      }),
    ).toThrowError(/ORQIS_WEB_RUNTIME_HOST must be set/);
  });

  it("fails fast when port is invalid", () => {
    expect(() =>
      resolveRuntimeProcessConfig({
        ORQIS_WEB_RUNTIME_HOST: "127.0.0.1",
        ORQIS_WEB_RUNTIME_PORT: "0",
      }),
    ).toThrowError(/ORQIS_WEB_RUNTIME_PORT must be an integer between 1 and 65535/);
  });

  it("detects symlinked entrypoint paths", () => {
    const modulePath = "/repo/apps/web/dist/runtime-process.js";
    const argvEntry = "/tmp/orqis-web-runtime";

    const resolvePath = (filePath: string): string => {
      if (filePath === argvEntry) {
        return modulePath;
      }

      return filePath;
    };

    expect(
      isWebRuntimeProcessEntrypoint(
        pathToFileURL(modulePath).href,
        argvEntry,
        resolvePath,
      ),
    ).toBe(true);
  });
});
