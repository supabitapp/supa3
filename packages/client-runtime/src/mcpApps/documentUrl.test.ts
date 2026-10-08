import { describe, expect, it, vi } from "vite-plus/test";

import { resolveMcpAppDocumentUrl } from "./documentUrl.ts";

describe("resolveMcpAppDocumentUrl", () => {
  it("retains an existing document URL while it has enough lifetime", async () => {
    const refresh = vi.fn(async () => "fresh-url");
    await expect(
      resolveMcpAppDocumentUrl({
        cached: { url: "cached-url", expiresAt: 40 * 60_000 },
        nowMs: 10 * 60_000,
        refresh,
      }),
    ).resolves.toBe("cached-url");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renews a cached URL after the app has been unmounted beyond its expiry", async () => {
    const refresh = vi.fn(async () => "fresh-url");
    await expect(
      resolveMcpAppDocumentUrl({
        cached: { url: "expired-url", expiresAt: 40 * 60_000 },
        nowMs: 70 * 60_000,
        refresh,
      }),
    ).resolves.toBe("fresh-url");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reauthorizes an explicitly reopened document and does not reuse the URL on failure", async () => {
    const refresh = vi.fn(async () => null);
    await expect(
      resolveMcpAppDocumentUrl({
        cached: { url: "cached-url", expiresAt: 40 * 60_000 },
        nowMs: 10 * 60_000,
        forceRefresh: true,
        refresh,
      }),
    ).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
