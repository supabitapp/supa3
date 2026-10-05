import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthEnvironmentScopes, AuthSessionState } from "./auth.ts";

const decodeScopes = Schema.decodeUnknownSync(AuthEnvironmentScopes);
const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

describe("AuthEnvironmentScopes", () => {
  it("drops scopes this build no longer knows instead of failing the decode", () => {
    expect(
      decodeScopes(["orchestration:read", "relay:read", "terminal:operate", "relay:write"]),
    ).toEqual(["orchestration:read", "terminal:operate"]);
  });

  it("keeps a stored session readable when its scopes include retired ones", () => {
    const session = decodeSessionState({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
        sessionCookieName: "supacode_session",
      },
      sessionMethod: "bearer-access-token",
      scopes: ["orchestration:read", "relay:read"],
    });
    expect(session.scopes).toEqual(["orchestration:read"]);
  });
});
