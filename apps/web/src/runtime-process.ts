import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  startOrqisWebRuntime,
  type StartOrqisWebRuntimeOptions,
} from "./index.js";

const WEB_RUNTIME_PROCESS_HOST_ENV_VAR = "ORQIS_WEB_RUNTIME_HOST";
const WEB_RUNTIME_PROCESS_PORT_ENV_VAR = "ORQIS_WEB_RUNTIME_PORT";
const WEB_RUNTIME_READY_MESSAGE_TYPE = "orqis:web-runtime-ready";
const WEB_RUNTIME_START_ERROR_MESSAGE_TYPE = "orqis:web-runtime-start-error";

type ResolveFilePath = (filePath: string) => string;

interface WebRuntimeReadyMessage {
  readonly type: typeof WEB_RUNTIME_READY_MESSAGE_TYPE;
  readonly baseUrl: string;
  readonly healthUrl: string;
}

interface WebRuntimeStartErrorMessage {
  readonly type: typeof WEB_RUNTIME_START_ERROR_MESSAGE_TYPE;
  readonly message: string;
  readonly code?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    return (error as NodeJS.ErrnoException).code;
  }

  return undefined;
}

function sendProcessMessage(
  message: WebRuntimeReadyMessage | WebRuntimeStartErrorMessage,
): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

export function resolveRuntimeProcessConfig(
  env: NodeJS.ProcessEnv = process.env,
): StartOrqisWebRuntimeOptions {
  const host = env[WEB_RUNTIME_PROCESS_HOST_ENV_VAR]?.trim();

  if (host === undefined || host.length === 0) {
    throw new Error(
      `${WEB_RUNTIME_PROCESS_HOST_ENV_VAR} must be set for the web runtime process.`,
    );
  }

  const rawPort = env[WEB_RUNTIME_PROCESS_PORT_ENV_VAR]?.trim();

  if (rawPort === undefined || !/^\d+$/.test(rawPort)) {
    throw new Error(
      `${WEB_RUNTIME_PROCESS_PORT_ENV_VAR} must be an integer between 1 and 65535.`,
    );
  }

  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `${WEB_RUNTIME_PROCESS_PORT_ENV_VAR} must be an integer between 1 and 65535.`,
    );
  }

  return {
    host,
    port,
  };
}

export async function runWebRuntimeProcess(): Promise<void> {
  let runtime;

  try {
    const runtimeConfig = resolveRuntimeProcessConfig();
    runtime = await startOrqisWebRuntime(runtimeConfig);
  } catch (error) {
    sendProcessMessage({
      type: WEB_RUNTIME_START_ERROR_MESSAGE_TYPE,
      message: getErrorMessage(error),
      code: getErrorCode(error),
    });
    throw error;
  }

  sendProcessMessage({
    type: WEB_RUNTIME_READY_MESSAGE_TYPE,
    baseUrl: runtime.baseUrl,
    healthUrl: runtime.healthUrl,
  });

  let stopPromise: Promise<void> | undefined;

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }

    stopPromise = runtime.stop();
    return stopPromise;
  };

  const shutdown = (): void => {
    void stop()
      .then(() => {
        process.exitCode ??= 0;
        process.exit();
      })
      .catch((error) => {
        console.error(`Web runtime process shutdown failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
        process.exit();
      });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("disconnect", shutdown);
}

export function isWebRuntimeProcessEntrypoint(
  moduleUrl: string,
  argvEntry: string | undefined,
  resolveFilePath: ResolveFilePath = realpathSync,
): boolean {
  if (argvEntry === undefined) {
    return false;
  }

  try {
    return (
      resolveFilePath(fileURLToPath(moduleUrl)) === resolveFilePath(argvEntry)
    );
  } catch {
    return fileURLToPath(moduleUrl) === argvEntry;
  }
}

const isEntrypoint = isWebRuntimeProcessEntrypoint(
  import.meta.url,
  process.argv[1],
);

if (isEntrypoint) {
  runWebRuntimeProcess().catch((error) => {
    console.error(`Web runtime process failed to start: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
