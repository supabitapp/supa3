import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isTailnetHost,
} from "@supacode/shared/hostClassification";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@supacode/contracts";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { BearerConnectionTarget, type ConnectionTarget } from "./model.ts";

/** Routes are ordered from the most direct address to the least specific fallback. */
export type ConnectionRouteKind = "loopback" | "lan" | "tailnet" | "public" | "ssh";

export function connectionRouteId(target: ConnectionTarget): string {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "primary";
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

export function connectionRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [{ target: entry.target, profile: entry.profile }, ...(entry.alternateRoutes ?? [])];
}

export function entryWithRoutes(
  entry: ConnectionCatalogEntry,
  routes: ReadonlyArray<ConnectionRoute>,
): ConnectionCatalogEntry {
  const [first, ...rest] = routes;
  if (first === undefined) throw new Error("A saved environment needs at least one route.");
  const { alternateRoutes: _previous, ...base } = entry;
  return {
    ...base,
    target: first.target,
    profile: first.profile,
    ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
  };
}

export function routeEntry(
  entry: ConnectionCatalogEntry,
  route: ConnectionRoute,
): ConnectionCatalogEntry {
  return entryWithRoutes(entry, [route]);
}

export function routeHttpBaseUrl(route: ConnectionRoute): string | null {
  if (route.target._tag === "PrimaryConnectionTarget") return route.target.httpBaseUrl;
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? profile.httpBaseUrl : null;
}

function routeUrl(route: ConnectionRoute): URL | null {
  const httpBaseUrl = routeHttpBaseUrl(route);
  if (httpBaseUrl === null) return null;
  try {
    return new URL(httpBaseUrl);
  } catch {
    return null;
  }
}

function routeHostname(route: ConnectionRoute): string | null {
  return routeUrl(route)?.hostname ?? null;
}

/**
 * The other saved addresses of the one environment that already has
 * `httpBaseUrl` as a route. A pairing link carries a single address, often a
 * LAN one this device cannot reach right now, but its token is accepted on
 * every address of that server.
 */
export function pairingFallbackRoutes(
  entries: Iterable<ConnectionCatalogEntry>,
  httpBaseUrl: string,
): { readonly environmentId: EnvironmentId; readonly httpBaseUrls: ReadonlyArray<string> } | null {
  const origin = new URL(httpBaseUrl).origin;
  const [owner, ...others] = [...entries].filter((entry) =>
    connectionRoutes(entry).some((route) => routeUrl(route)?.origin === origin),
  );
  // A private address can belong to a different machine on each network.
  if (owner === undefined || others.length > 0) return null;
  const fallbacks = new Map<string, string>();
  for (const route of connectionRoutes(owner)) {
    const url = routeUrl(route);
    if (url === null || url.origin === origin || fallbacks.has(url.origin)) continue;
    fallbacks.set(url.origin, url.href);
  }
  return fallbacks.size === 0
    ? null
    : { environmentId: owner.target.environmentId, httpBaseUrls: [...fallbacks.values()] };
}

export function connectionRouteKind(route: ConnectionRoute): ConnectionRouteKind {
  switch (route.target._tag) {
    case "SshConnectionTarget":
      return "ssh";
    case "PrimaryConnectionTarget":
    case "BearerConnectionTarget": {
      const hostname = routeHostname(route);
      if (hostname === null) return "public";
      if (isLocalLoopbackHost(hostname)) return "loopback";
      if (isTailnetHost(hostname)) return "tailnet";
      return isPrivateNetworkHost(hostname) ? "lan" : "public";
    }
  }
}

const ROUTE_KIND_RANK: Record<ConnectionRouteKind, number> = {
  loopback: 0,
  lan: 1,
  tailnet: 2,
  public: 3,
  ssh: 4,
};

export function insertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const rank = ROUTE_KIND_RANK[connectionRouteKind(route)];
  const index = routes.findIndex(
    (existing) => ROUTE_KIND_RANK[connectionRouteKind(existing)] > rank,
  );
  return index === -1
    ? [...routes, route]
    : [...routes.slice(0, index), route, ...routes.slice(index)];
}

export function upsertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const id = connectionRouteId(route.target);
  return routes.some((existing) => connectionRouteId(existing.target) === id)
    ? routes.map((existing) => (connectionRouteId(existing.target) === id ? route : existing))
    : insertRoute(routes, route);
}

export function findRouteToSameAddress(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ConnectionRoute | undefined {
  const key = routeAddressKey(route);
  return key === null ? undefined : routes.find((existing) => routeAddressKey(existing) === key);
}

function routeAddressKey(route: ConnectionRoute): string | null {
  const profile = Option.getOrNull(route.profile);
  switch (profile?._tag) {
    case "BearerConnectionProfile":
      return `bearer:${profile.httpBaseUrl.replace(/\/+$/, "")}`;
    case "SshConnectionProfile":
      return `ssh:${sshTargetKey(profile.target)}`;
    default:
      return null;
  }
}

export function connectionRouteLabel(route: ConnectionRoute): string {
  switch (connectionRouteKind(route)) {
    case "loopback":
      return "This device";
    case "lan":
      return "LAN";
    case "tailnet":
      return "Tailscale";
    case "ssh": {
      const profile = Option.getOrNull(route.profile);
      return profile?._tag === "SshConnectionProfile"
        ? `SSH ${profile.target.username ? `${profile.target.username}@` : ""}${profile.target.hostname}`
        : "SSH";
    }
    case "public":
      return routeHostname(route) ?? "Remote link";
  }
}

export function connectionRouteAddress(route: ConnectionRoute): string | null {
  if (route.target._tag === "SshConnectionTarget") {
    const profile = Option.getOrNull(route.profile);
    return profile?._tag === "SshConnectionProfile" ? profile.target.alias : null;
  }
  return routeHttpBaseUrl(route);
}

export function mergeLearnedRoutes(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly activeRoute: ConnectionRoute;
  readonly reported: ReadonlyArray<{ readonly httpBaseUrl: string }>;
  readonly allowInsecure: boolean;
}): ReadonlyArray<ConnectionRoute> | null {
  const { entry } = input;
  const active = input.activeRoute.target;
  const saved = connectionRoutes(entry);
  if (active._tag !== "BearerConnectionTarget") return null;
  const sharedCredential = credentialConnectionId(active.connectionId);

  const reported = new Map<string, URL>();
  for (const endpoint of input.reported) {
    let url: URL;
    try {
      url = new URL(endpoint.httpBaseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.protocol === "http:" && !input.allowInsecure) continue;
    if (isLocalLoopbackHost(url.hostname)) continue;
    reported.set(url.origin, url);
  }
  const normalized = (url: string) => url.replace(/\/+$/, "");
  const known = new Set(
    saved.flatMap((route) => {
      const url = routeHttpBaseUrl(route);
      return url === null || isLearned(route) ? [] : [normalized(url)];
    }),
  );
  const kept = saved.filter((route) => {
    if (!isLearned(route)) return true;
    const url = routeHttpBaseUrl(route);
    if (url === null || !reported.has(normalized(url)) || known.has(normalized(url))) return false;
    known.add(normalized(url));
    return true;
  });
  let next: ReadonlyArray<ConnectionRoute> = kept;
  for (const url of reported.values()) {
    if (known.has(url.origin)) continue;
    const httpBaseUrl = `${url.origin}/`;
    const connectionId = learnedConnectionId(
      entry.target.environmentId,
      url.origin,
      sharedCredential,
    );
    next = insertRoute(next, {
      target: new BearerConnectionTarget({
        environmentId: entry.target.environmentId,
        label: entry.target.label,
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: entry.target.environmentId,
          label: entry.target.label,
          httpBaseUrl,
          wsBaseUrl: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/`,
          learned: true,
        }),
      ),
    });
  }
  const signature = (routes: ReadonlyArray<ConnectionRoute>) =>
    routes
      .map((route) => `${connectionRouteId(route.target)} ${routeHttpBaseUrl(route) ?? ""}`)
      .join("\n");
  return signature(saved) === signature(next) ? null : next;
}

function learnedConnectionId(
  environmentId: string,
  origin: string,
  sharedCredential: string,
): string {
  return `learned:${environmentId}:${origin}@${sharedCredential}`;
}

export function credentialConnectionId(connectionId: string): string {
  const at = connectionId.indexOf("@");
  return connectionId.startsWith("learned:") && at !== -1
    ? connectionId.slice(at + 1)
    : connectionId;
}

export function isLearned(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" && profile.learned === true;
}

export function routesAfterRemoving(
  routes: ReadonlyArray<ConnectionRoute>,
  removedId: string,
): ReadonlyArray<ConnectionRoute> {
  const removed = routes.find((route) => connectionRouteId(route.target) === removedId);
  if (removed === undefined) return routes;
  return routes.filter((route) => {
    if (route === removed) return false;
    if (!isLearned(route)) return true;
    return credentialConnectionId(connectionRouteId(route.target)) !== removedId;
  });
}

export function sshTargetKey(target: DesktopSshEnvironmentTarget): string {
  return JSON.stringify([target.alias, target.hostname, target.username, target.port]);
}
