export const TUNNEL_PACKAGE_NAME = "@orqis/tunnel";

export interface TunnelSession {
  readonly provider: string;
  readonly publicUrl: string;
}

export function createPlaceholderTunnelSession(): TunnelSession {
  return {
    provider: "placeholder",
    publicUrl: "https://example.invalid",
  };
}
