import { relayHttpBaseUrl } from "@supacode/shared/relay/protocol";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("keeps relay pairing links in clients that support the relay transport", () => {
    const address = relayHttpBaseUrl(new Uint8Array(32));
    expect(resolveHostedPairingUrl(address, "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl(address, "PAIRCODE")).toBe(`${address}pair#token=PAIRCODE`);
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
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.supacode.sh");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.supacode.sh/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
