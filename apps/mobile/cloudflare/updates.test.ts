import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import updates from "./updates";

const releaseFile = {
  part: "manifest",
  body: '{"id":"00000000-0000-4000-8000-000000000000"}',
  signature: 'sig="c2lnbmF0dXJl", keyid="main"',
};

function manifestRequest(headers: Record<string, string>, search = "") {
  return new Request(`https://updates.next.supacode.sh/manifest${search}`, { headers });
}

const iosProduction = {
  "expo-platform": "ios",
  "expo-runtime-version": "1a2b",
  "expo-channel-name": "production",
};

function stubGitHub(response: () => Response) {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  const entries = new Map<string, Response>();
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        entries.set(request.url, response);
      },
    }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("mobile update manifests", () => {
  it("serves the release's current update as a signed multipart part", async () => {
    const fetch = stubGitHub(() => Response.json(releaseFile));
    const response = await updates.fetch(manifestRequest(iosProduction));

    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/supabitapp/supacode-mobile-updates/releases/download/ota-production-ios-1a2b/current.json",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    const boundary = /^multipart\/mixed; boundary=(.+)$/.exec(
      response.headers.get("content-type") ?? "",
    )?.[1];
    expect(await response.text()).toBe(
      [
        `--${boundary}`,
        'content-disposition: form-data; name="manifest"',
        "content-type: application/json; charset=utf-8",
        `expo-signature: ${releaseFile.signature}`,
        "",
        releaseFile.body,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
  });

  it("reports no update for a runtime nothing was published to, and remembers that", async () => {
    const fetch = stubGitHub(() => new Response("Not Found", { status: 404 }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await updates.fetch(manifestRequest(iosProduction));
      expect(response.status).toBe(204);
      expect(response.headers.get("expo-protocol-version")).toBe("1");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks GitHub again after a failed read", async () => {
    const fetch = stubGitHub(() => new Response("Unavailable", { status: 503 }));
    expect((await updates.fetch(manifestRequest(iosProduction))).status).toBe(502);
    expect((await updates.fetch(manifestRequest(iosProduction))).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("lets a preview link's channel override the channel built into the app", async () => {
    const fetch = stubGitHub(() => Response.json(releaseFile));
    await updates.fetch(
      manifestRequest(
        {
          "expo-platform": "android",
          "expo-runtime-version": "1a2b",
          "expo-channel-name": "preview",
        },
        "?channel=pr-12",
      ),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/supabitapp/supacode-mobile-updates/releases/download/ota-pr-12-android-1a2b/current.json",
    );
  });

  it.each([
    [{ "expo-runtime-version": "1a2b" }, ""],
    [{ "expo-platform": "web", "expo-runtime-version": "1a2b" }, ""],
    [{ "expo-platform": "ios", "expo-runtime-version": "1a2b" }, "?channel=../production"],
  ])("rejects %o%s without reading a release", async (headers, search) => {
    const fetch = stubGitHub(() => Response.json(releaseFile));
    expect((await updates.fetch(manifestRequest(headers, search))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("preview links", () => {
  it("opens a PR channel in the preview development build", async () => {
    const response = await updates.fetch(
      new Request("https://updates.next.supacode.sh/open?channel=pr-12"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `supacode-preview://expo-development-client/?url=${encodeURIComponent(
        "https://updates.next.supacode.sh/manifest?channel=pr-12",
      )}`,
    );
  });
});
