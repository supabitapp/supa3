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
  connectionRouteKind,
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
    const tailnetRoute = route("http://100.100.10.2:4389", "tailnet");
    const lanRoute = route("http://192.168.1.20:4389", "lan");
    expect(connectionRouteKind(lanRoute)).toBe("lan");
    expect(connectionRouteKind(tailnetRoute)).toBe("tailnet");
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
