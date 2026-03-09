import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const WEB_PACKAGE_NAME = "@orqis/web";

export interface StartOrqisWebRuntimeOptions {
  readonly host: string;
  readonly port: number;
}

export interface OrqisWebRuntimeHealthPayload {
  readonly service: typeof WEB_PACKAGE_NAME;
  readonly status: "ok";
  readonly uptimeMs: number;
}

export interface OrqisWebRuntimeHandle {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly healthUrl: string;
  stop(): Promise<void>;
}

export function getWebRuntimeLabel(): string {
  return "Orqis Web runtime scaffold";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveRuntimeClientHost(
  host: string,
  address: AddressInfo,
): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (host === "::" || host === "[::]") {
    return address.family === "IPv6" ? "::1" : "127.0.0.1";
  }

  return host;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
  });
  response.end(body);
}

function createHealthPayload(startedAt: number): OrqisWebRuntimeHealthPayload {
  return {
    service: WEB_PACKAGE_NAME,
    status: "ok",
    uptimeMs: Math.max(0, Date.now() - startedAt),
  };
}

function resolvePathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  startedAt: number,
): void {
  const pathname = resolvePathname(request);

  if (request.method === "GET" && pathname === "/health") {
    writeJson(response, 200, createHealthPayload(startedAt));
    return;
  }

  if (request.method === "GET" && pathname === "/") {
    writeText(
      response,
      200,
      "<!doctype html><title>Orqis</title><body><h1>Orqis control center is starting up.</h1></body>",
      "text/html; charset=utf-8",
    );
    return;
  }

  writeJson(response, 404, {
    error: "Not Found",
    path: pathname,
  });
}

async function listen(
  host: string,
  port: number,
  startedAt: number,
): Promise<{ address: AddressInfo; stop: () => Promise<void> }> {
  const server = createServer((request, response) => {
    handleRequest(request, response, startedAt);
  });

  const stop = async (): Promise<void> => {
    if (!server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  };

  try {
    const address = await new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = (): void => {
        server.off("error", onError);
        const value = server.address();

        if (!value || typeof value === "string") {
          reject(new Error("Orqis web runtime did not expose a TCP address."));
          return;
        }

        resolve(value);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

    return { address, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

export async function startOrqisWebRuntime(
  options: StartOrqisWebRuntimeOptions,
): Promise<OrqisWebRuntimeHandle> {
  const startedAt = Date.now();
  const { address, stop } = await listen(
    options.host,
    options.port,
    startedAt,
  );

  const host = resolveRuntimeClientHost(options.host, address);
  const baseUrl = `http://${formatHostForUrl(host)}:${address.port}`;

  return {
    host,
    port: address.port,
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    stop,
  };
}
