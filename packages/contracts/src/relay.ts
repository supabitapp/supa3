import * as Schema from "effect/Schema";

export const DEFAULT_PUBLIC_RELAY_URL = "wss://supacode-relay.exe.xyz";

export function normalizeRelayServerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export const RelayServerUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => normalizeRelayServerUrl(value) === value, {
    expected: "a ws: or wss: relay URL without credentials, query, or fragment",
  }),
);

export const RelayHostState = Schema.Literals([
  "off",
  "connecting",
  "registered",
  "superseded",
  "invalid-url",
]);
export type RelayHostState = typeof RelayHostState.Type;

export const RelayHostStatus = Schema.Struct({
  state: RelayHostState,
  relayEndpoint: Schema.optionalKey(Schema.String),
  relayUrl: Schema.optionalKey(Schema.String),
});
export type RelayHostStatus = typeof RelayHostStatus.Type;

export const RelayAdvertisement = Schema.Struct({
  relayEndpoint: Schema.String,
  relayUrl: Schema.String,
});
export type RelayAdvertisement = typeof RelayAdvertisement.Type;

export function relayAdvertisementFrom(value: {
  readonly relayEndpoint?: string;
  readonly relayUrl?: string;
}): RelayAdvertisement | null {
  return value.relayEndpoint === undefined || value.relayUrl === undefined
    ? null
    : { relayEndpoint: value.relayEndpoint, relayUrl: value.relayUrl };
}

export function withRelayAdvertisement<
  T extends { readonly relayEndpoint?: string; readonly relayUrl?: string },
>(value: T, advertisement: RelayAdvertisement | null) {
  const { relayEndpoint: _endpoint, relayUrl: _url, ...rest } = value;
  return { ...rest, ...advertisement };
}

export const RelayCompanionRequest = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  action: Schema.Literals(["open", "close"]),
  address: Schema.String.check(Schema.isMaxLength(256)),
  relayUrl: Schema.optionalKey(RelayServerUrl),
});

export const RelayCompanionReply = Schema.Struct({
  id: Schema.String,
  origin: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
