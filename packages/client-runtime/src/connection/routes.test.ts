import { EnvironmentId } from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionRoute,
  SshConnectionTarget,
} from "./index.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  entryWithRoutes,
  insertRoute,
  isLearned,
  mergeLearnedRoutes,
  pairingFallbackRoutes,
  routesAfterRemoving,
} from "./routes.ts";

const environmentId = EnvironmentId.make("environment-routes");
const credential = "bearer:environment-routes";

function route(
  httpBaseUrl: string,
  connectionId = credential,
  environment = environmentId,
): ConnectionRoute {
  const target = new BearerConnectionTarget({
    environmentId: environment,
    label: "Remote",
    connectionId,
  });
  return {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: environment,
        label: "Remote",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

describe("connection routes", () => {
  it("orders LAN ahead of Tailscale and public routes", () => {
    const publicRoute = route("https://remote.example.test", "public");
    const tailnetRoute = route("http://machine.tail1234.ts.net:4389", "tailnet");
    const lanRoute = route("http://192.168.1.20:4389", "lan");
    expect(connectionRouteKind(lanRoute)).toBe("lan");
    expect(connectionRouteKind(tailnetRoute)).toBe("tailnet");
    // Tailscale, Cloudflare WARP and Mesh, and other VPNs share 100.64.0.0/10.
    expect(connectionRouteKind(route("http://100.100.10.2:4389", "vpn"))).toBe("vpn");
    expect(connectionRouteLabel(route("http://100.96.0.1:4389", "mesh"))).toBe("VPN");
    expect(
      insertRoute(insertRoute([publicRoute], tailnetRoute), lanRoute).map((item) =>
        connectionRouteKind(item),
      ),
    ).toEqual(["lan", "tailnet", "public"]);
  });

  it("learns both direct endpoint kinds while reusing the paired credential", () => {
    const active = route("https://remote.example.test");
    const entry = entryWithRoutes(
      { target: active.target, profile: active.profile, enabled: true },
      [active],
    );
    const learned = mergeLearnedRoutes({
      entry,
      activeRoute: active,
      reported: [
        { httpBaseUrl: "http://192.168.1.20:4389/" },
        { httpBaseUrl: "http://100.100.10.2:4389/" },
      ],
      allowInsecure: true,
    });
    expect(learned).not.toBeNull();
    expect(learned).toHaveLength(3);
    const learnedRoutes = learned?.filter(isLearned) ?? [];
    expect(learnedRoutes).toHaveLength(2);
    expect(
      learnedRoutes.map((item) =>
        item.target._tag === "BearerConnectionTarget" ? item.target.connectionId : "",
      ),
    ).toEqual([
      "learned:environment-routes:http://192.168.1.20:4389@bearer:environment-routes",
      "learned:environment-routes:http://100.100.10.2:4389@bearer:environment-routes",
    ]);
  });

  it("labels a learned address Tailscale only while the server reports it as tailnet", () => {
    const active = route("https://remote.example.test");
    const entry = entryWithRoutes(
      { target: active.target, profile: active.profile, enabled: true },
      [active],
    );
    const tailscale = { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" };
    const mesh = { kind: "lan", httpBaseUrl: "http://100.96.0.1:3773/" };
    const first = mergeLearnedRoutes({
      entry,
      activeRoute: active,
      reported: [tailscale, mesh],
      allowInsecure: true,
    })!;
    expect(first.map(connectionRouteLabel)).toEqual(["Tailscale", "VPN", "remote.example.test"]);

    // The server later finds the address is not on its Tailscale interface.
    const corrected = mergeLearnedRoutes({
      entry: entryWithRoutes(entry, first),
      activeRoute: active,
      reported: [{ ...tailscale, kind: "lan" }, mesh],
      allowInsecure: true,
    })!;
    expect(corrected.map((item) => connectionRouteId(item.target))).toEqual(
      first.map((item) => connectionRouteId(item.target)),
    );
    expect(corrected.map(connectionRouteLabel)).toEqual(["VPN", "VPN", "remote.example.test"]);
    expect(
      mergeLearnedRoutes({
        entry: entryWithRoutes(entry, corrected),
        activeRoute: active,
        reported: [{ ...tailscale, kind: "lan" }, mesh],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  it("labels a paired numeric Tailscale address Tailscale once the server confirms it", () => {
    const paired = route("http://100.101.102.103:3773/", "paired");
    const other = route("http://100.96.0.1:3773/", "other");
    const entry = entryWithRoutes(
      { target: paired.target, profile: paired.profile, enabled: true },
      [paired, other],
    );
    expect(connectionRouteLabel(paired)).toBe("VPN");
    const confirmed = mergeLearnedRoutes({
      entry,
      activeRoute: paired,
      reported: [{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" }],
      allowInsecure: true,
    })!;
    // Same routes in the same order; only the label of the confirmed one changes.
    expect(confirmed.map((item) => connectionRouteId(item.target))).toEqual(["paired", "other"]);
    expect(confirmed.map(connectionRouteLabel)).toEqual(["Tailscale", "VPN"]);
  });

  it("drops learned routes when the paired route is removed", () => {
    const active = route("https://remote.example.test");
    const learned = mergeLearnedRoutes({
      entry: { target: active.target, profile: active.profile, enabled: true },
      activeRoute: active,
      reported: [{ httpBaseUrl: "http://192.168.1.20:4389/" }],
      allowInsecure: true,
    })!;
    const learnedRoute = learned.find(isLearned)!;
    expect(
      routesAfterRemoving(
        learned,
        learnedRoute.target._tag === "BearerConnectionTarget"
          ? learnedRoute.target.connectionId
          : "",
      ),
    ).toHaveLength(1);
    expect(routesAfterRemoving(learned, credential)).toHaveLength(0);
  });

  it("offers the other addresses of the saved environment a pairing link points at", () => {
    const tailnet = route("https://minim5.tail.ts.net/", "tailnet");
    const lan = route("http://192.168.1.20:4389/", "learned-lan");
    const ssh: ConnectionRoute = {
      target: new SshConnectionTarget({ environmentId, label: "Remote", connectionId: "ssh" }),
      profile: Option.none(),
    };
    const entry = entryWithRoutes(
      { target: tailnet.target, profile: tailnet.profile, enabled: true },
      [lan, tailnet, route("https://minim5.tail.ts.net/other-path/", "tailnet-duplicate"), ssh],
    );
    const entries = new Map([[environmentId, entry]]);

    expect(pairingFallbackRoutes(entries, "http://192.168.1.20:4389/", undefined)).toEqual({
      environmentId,
      httpBaseUrls: ["https://minim5.tail.ts.net/"],
    });
    expect(pairingFallbackRoutes(entries, "http://192.168.1.30:4389/", undefined)).toBeNull();
  });

  it("offers no fallback when two saved environments share the address", () => {
    const lan = route("http://192.168.1.20:4389/", "lan");
    const home = entryWithRoutes({ target: lan.target, profile: lan.profile, enabled: true }, [
      lan,
      route("https://minim5.tail.ts.net/", "tailnet"),
    ]);
    const officeId = EnvironmentId.make("environment-office");
    const officeLan = route("http://192.168.1.20:4389/", "office-lan", officeId);
    const office = { target: officeLan.target, profile: officeLan.profile, enabled: true };

    expect(
      pairingFallbackRoutes(
        new Map([[environmentId, home]]),
        "http://192.168.1.20:4389/",
        undefined,
      ),
    ).not.toBeNull();
    expect(
      pairingFallbackRoutes(
        new Map([
          [environmentId, home],
          [officeId, office],
        ]),
        "http://192.168.1.20:4389/",
        undefined,
      ),
    ).toBeNull();
  });

  it("pairs a route added to a named environment through its saved addresses", () => {
    const tailnet = route("https://minim5.tail.ts.net/", "tailnet");
    const entry = { target: tailnet.target, profile: tailnet.profile, enabled: true };
    const entries = new Map([[environmentId, entry]]);

    expect(pairingFallbackRoutes(entries, "http://192.168.1.99:4389/", undefined)).toBeNull();
    expect(pairingFallbackRoutes(entries, "http://192.168.1.99:4389/", environmentId)).toEqual({
      environmentId,
      httpBaseUrls: ["https://minim5.tail.ts.net/"],
    });
  });
});
