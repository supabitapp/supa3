import {
  MOBILE_OTA_CURRENT_FILE,
  type MobileOtaReleaseFile,
  isMobileOtaChannel,
  mobileOtaAssetUrl,
  mobileOtaReleaseTag,
} from "../../../scripts/lib/mobile-ota.ts";

// How long a location reuses a release's current.json before asking GitHub again.
const CURRENT_CACHE_SECONDS = 60;
// PR updates only open in preview development builds.
const PREVIEW_SCHEME = "supacode-preview";

const PROTOCOL_HEADERS = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "cache-control": "private, max-age=0",
};

/**
 * Serves self-hosted updates to expo-updates. GitHub release assets cannot carry the
 * protocol headers expo-updates requires, so this Worker reads the signed `current.json`
 * from the matching release and answers with the Expo Updates v1 multipart response.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname === "/manifest") return serveManifest(request, url);
    if (url.pathname === "/open") return openPreview(url);
    return new Response("Not found", { status: 404 });
  },
};

async function serveManifest(request: Request, url: URL): Promise<Response> {
  const platform = request.headers.get("expo-platform");
  const runtimeVersion = request.headers.get("expo-runtime-version");
  if ((platform !== "ios" && platform !== "android") || !runtimeVersion) {
    return badRequest("Expected expo-platform and expo-runtime-version headers.");
  }
  // Preview links pin a channel in the URL; store builds send the channel set in app.config.ts.
  const channel =
    url.searchParams.get("channel") ?? request.headers.get("expo-channel-name") ?? "production";
  const tag = mobileOtaReleaseTag(channel, platform, runtimeVersion);
  if (!tag) return badRequest("Unsupported channel or runtime version.");

  let current: MobileOtaReleaseFile | null;
  try {
    current = await readCurrent(url, tag);
  } catch (error) {
    console.error(`Could not read ${tag}/${MOBILE_OTA_CURRENT_FILE}`, error);
    return new Response(null, { status: 502 });
  }
  if (!current) return new Response(null, { status: 204, headers: PROTOCOL_HEADERS });

  const boundary = `supacode-ota-${crypto.randomUUID()}`;
  return new Response(multipartBody(current, boundary), {
    headers: { ...PROTOCOL_HEADERS, "content-type": `multipart/mixed; boundary=${boundary}` },
  });
}

async function readCurrent(url: URL, tag: string): Promise<MobileOtaReleaseFile | null> {
  const cache = await caches.open("mobile-ota");
  const key = new Request(new URL(`/__current/${tag}`, url));
  const cached = await cache.match(key);
  if (cached) return parseReleaseFile(await cached.text());

  const upstream = await fetch(mobileOtaAssetUrl(tag, MOBILE_OTA_CURRENT_FILE));
  if (!upstream.ok && upstream.status !== 404) {
    throw new Error(`GitHub answered ${upstream.status}`);
  }
  // A missing release means nothing was published for this runtime, which is cached too.
  const text = upstream.ok ? await upstream.text() : "null";
  const current = parseReleaseFile(text);
  await cache.put(
    key,
    new Response(text, { headers: { "cache-control": `max-age=${CURRENT_CACHE_SECONDS}` } }),
  );
  return current;
}

function parseReleaseFile(text: string): MobileOtaReleaseFile | null {
  const value: unknown = JSON.parse(text);
  if (value === null) return null;
  if (
    typeof value === "object" &&
    "part" in value &&
    (value.part === "manifest" || value.part === "directive") &&
    "body" in value &&
    typeof value.body === "string" &&
    "signature" in value &&
    typeof value.signature === "string"
  ) {
    return { part: value.part, body: value.body, signature: value.signature };
  }
  throw new Error("Malformed release file");
}

function multipartBody(file: MobileOtaReleaseFile, boundary: string): string {
  return [
    `--${boundary}`,
    `content-disposition: form-data; name="${file.part}"`,
    "content-type: application/json; charset=utf-8",
    `expo-signature: ${file.signature}`,
    "",
    file.body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Redirects to a preview development build so a PR comment can link straight to its update. */
function openPreview(url: URL): Response {
  const channel = url.searchParams.get("channel");
  if (!channel || !isMobileOtaChannel(channel)) return badRequest("Unsupported channel.");
  const manifestUrl = new URL("/manifest", url);
  manifestUrl.searchParams.set("channel", channel);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${PREVIEW_SCHEME}://expo-development-client/?url=${encodeURIComponent(manifestUrl.href)}`,
      "Cache-Control": "no-store",
    },
  });
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}
