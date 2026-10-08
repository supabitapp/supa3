import type { PreparedConnection } from "@supacode/client-runtime/connection";
import { isLoopbackHost } from "@supacode/shared/preview";

export function isLocalProviderAuthConnection(connection: PreparedConnection | null): boolean {
  return (
    connection !== null &&
    (connection.connectionMethod === undefined || connection.connectionMethod === "direct") &&
    isLoopbackHost(new URL(connection.httpBaseUrl).hostname)
  );
}

export function readCodexSetupMode(config: unknown): "managed" | "existing" {
  return config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "managed"
    ? "managed"
    : "existing";
}
