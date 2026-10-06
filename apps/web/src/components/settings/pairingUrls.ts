import { buildHostedPairingUrl } from "../../hostedPairing";
import { buildPairingUrl, type PairingRouteHints } from "@supacode/shared/remote";

export function resolveDesktopPairingUrl(
  endpointUrl: string,
  credential: string,
  hints: PairingRouteHints = {},
): string {
  return buildPairingUrl(endpointUrl, credential, hints);
}

export function resolveHostedPairingUrl(
  endpointUrl: string,
  credential: string,
  hints: PairingRouteHints = {},
): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
    ...hints,
  });
}
