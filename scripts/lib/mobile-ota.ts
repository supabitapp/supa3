/**
 * Shared layout of self-hosted mobile OTA updates. `scripts/mobile-ota.ts` publishes signed
 * updates to GitHub releases in this layout, and the Worker in `apps/mobile/cloudflare` serves
 * them to expo-updates.
 */

/** Public repository whose releases hold update bundles, assets, and signed manifests. */
export const MOBILE_OTA_REPOSITORY = "supabitapp/supacode-mobile-updates";
/** Origin of the Worker that answers expo-updates manifest requests. */
export const MOBILE_OTA_ORIGIN = "https://updates.next.supacode.sh";
export const MOBILE_OTA_MANIFEST_URL = `${MOBILE_OTA_ORIGIN}/manifest`;
/** Release asset holding the update or directive the Worker currently serves. */
export const MOBILE_OTA_CURRENT_FILE = "current.json";

export type MobileOtaPlatform = "ios" | "android";

/**
 * Contents of `current.json` and of each `update-*.json` history file. `body` is the exact
 * JSON the signature covers, so it is stored as a string and never re-serialized.
 */
export interface MobileOtaReleaseFile {
  readonly part: "manifest" | "directive";
  readonly body: string;
  /** `expo-signature` structured header value for `body`. */
  readonly signature: string;
  readonly message?: string;
}

const CHANNEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Runtime versions become part of a git tag, so they stay within characters git allows.
const RUNTIME_VERSION_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isMobileOtaChannel(value: string): boolean {
  return value.length <= 64 && CHANNEL_PATTERN.test(value);
}

export function isMobileOtaRuntimeVersion(value: string): boolean {
  return value.length <= 128 && RUNTIME_VERSION_PATTERN.test(value);
}

/** One release per channel, platform, and runtime version; `undefined` for unsafe input. */
export function mobileOtaReleaseTag(
  channel: string,
  platform: MobileOtaPlatform,
  runtimeVersion: string,
): string | undefined {
  if (!isMobileOtaChannel(channel) || !isMobileOtaRuntimeVersion(runtimeVersion)) {
    return undefined;
  }
  return `ota-${channel}-${platform}-${runtimeVersion}`;
}

export function isMobileOtaChannelTag(tag: string, channel: string): boolean {
  const prefix = `ota-${channel}-`;
  if (!tag.startsWith(prefix)) return false;
  const rest = tag.slice(prefix.length);
  return ["ios-", "android-"].some(
    (platform) =>
      rest.startsWith(platform) && isMobileOtaRuntimeVersion(rest.slice(platform.length)),
  );
}

export function mobileOtaAssetUrl(tag: string, name: string): string {
  return `https://github.com/${MOBILE_OTA_REPOSITORY}/releases/download/${tag}/${name}`;
}
