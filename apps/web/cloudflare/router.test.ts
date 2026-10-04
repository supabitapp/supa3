import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import router from "./router";

afterEach(() => vi.unstubAllGlobals());

describe("hosted channel routing", () => {
  it.each(["nightly", "latest", "invalid"])(
    "sets a secure channel cookie for %s",
    async (channel) => {
      const response = await router.fetch(
        new Request(`https://app.next.supacode.sh/__supacode/channel?channel=${channel}`),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/");
      expect(response.headers.get("Set-Cookie")).toBe(
        `supacode_web_channel=${channel === "nightly" ? "nightly" : "latest"}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it.each([
    ["", "latest"],
    ["other=nightly", "latest"],
    ["supacode_web_channel=nightly-extra", "latest"],
    ["other=x; supacode_web_channel=nightly", "nightly"],
    ["supacode_web_channel=latest", "latest"],
  ])("routes cookie %s to %s without changing the path or query", async (cookie, channel) => {
    const fetch = vi.fn().mockResolvedValue(new Response("asset", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const response = await router.fetch(
      new Request("https://app.next.supacode.sh/assets/app.js?v=42", {
        headers: { Cookie: cookie, "If-None-Match": "asset-v1" },
      }),
    );
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(`https://${channel}.app.next.supacode.sh/assets/app.js?v=42`);
    expect(request.headers.get("If-None-Match")).toBe("asset-v1");
    expect(await response.text()).toBe("asset");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
  });
});
