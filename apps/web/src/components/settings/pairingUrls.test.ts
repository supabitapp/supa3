import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@supacode/contracts";
import { resolveRemotePairingTarget } from "@supacode/shared/remote";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("carries the same identity and routes through direct and hosted links", () => {
    const hints = {
      environmentId: EnvironmentId.make("machine"),
      routes: ["https://machine.ts.net", "http://100.64.1.2:3773"],
    };
    for (const pairingUrl of [
      resolveDesktopPairingUrl("https://public.test", "code", hints),
      resolveHostedPairingUrl("https://public.test", "code", hints),
    ]) {
      expect(resolveRemotePairingTarget({ pairingUrl: pairingUrl! })).toMatchObject({
        environmentId: hints.environmentId,
        routes: ["https://machine.ts.net/", "http://100.64.1.2:3773/"],
      });
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.next.supacode.sh");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.next.supacode.sh/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
