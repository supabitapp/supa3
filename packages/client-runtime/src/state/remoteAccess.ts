import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Shared commands keep web, desktop, mobile and agents on the same service. */
export function createRemoteAccessAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const statusAtom = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "remote-access:status",
    tag: "remoteAccess.getStatus",
    refreshIntervalMs: 5_000,
  });
  const setupAtom = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "remote-access:setup",
    tag: "remoteAccess.getSetup",
  });
  const command = <
    Tag extends
      | "remoteAccess.configure"
      | "remoteAccess.setEnabled"
      | "remoteAccess.repair"
      | "remoteAccess.remove",
  >(
    tag: Tag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: tag,
      tag,
      scheduler,
      concurrency: { mode: "serial", key: (target) => target.environmentId },
    });
  return {
    statusAtom,
    setupAtom,
    configure: command("remoteAccess.configure"),
    setEnabled: command("remoteAccess.setEnabled"),
    repair: command("remoteAccess.repair"),
    remove: command("remoteAccess.remove"),
  };
}

export function remoteAccessEndpoint(
  status: import("@supacode/contracts").SelfHostedRemoteAccessStatus | null,
): import("@supacode/contracts").AdvertisedEndpoint | null {
  if (!status?.ready || !status.enabled || !status.publicUrl) return null;
  return {
    id: "self-hosted-cloudflare",
    label: "Cloudflare",
    provider: { id: "self-hosted-cloudflare", label: "Cloudflare", kind: "tunnel", isAddon: false },
    httpBaseUrl: status.publicUrl,
    wsBaseUrl: status.publicUrl.replace(/^https:/, "wss:"),
    reachability: "public",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "server",
    status: "available",
  };
}

export function remoteAccessStatusLabel(
  status: import("@supacode/contracts").SelfHostedRemoteAccessStatus,
): string {
  if (status.ready)
    return status.state === "needs-login" ? "Connected · login needed" : "Connected";
  return {
    unconfigured: "Not set up",
    disabled: "Disabled",
    connecting: "Connecting",
    connected: "Connecting",
    "needs-login": "Cloudflare login needed",
    error: "Needs attention",
    "cleanup-pending": "Removal incomplete",
    "relay-mode": "Account relay",
  }[status.state];
}

export function remoteAccessFailureMessage(
  failure: import("@supacode/contracts").SelfHostedRemoteAccessStatus["failure"],
): string | null {
  if (failure === null) return null;
  return {
    "login-required": "Sign in to Cloudflare again on the host, then repair remote access.",
    "provision-failed": "Cloudflare setup could not complete. Ask your agent to repair it.",
    "connector-failed": "The connector could not start. Repair remote access on this host.",
    "endpoint-unavailable": "The public address is not answering for this environment yet.",
    "cleanup-failed":
      "Some resources could not be removed. Retry removal after restoring Cloudflare access.",
  }[failure];
}
