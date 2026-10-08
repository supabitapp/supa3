import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@supacode/contracts";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@supacode/client-runtime/connection";
import { isLocalProviderAuthConnection } from "./CodexSetupSection.logic";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("auth-environment"),
  label: "Host",
  httpBaseUrl: "http://127.0.0.1:5774",
  wsBaseUrl: "ws://127.0.0.1:5774",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl + "/ws",
  httpAuthorization: null,
};

describe("provider callback locality", () => {
  it("uses local callbacks only for direct loopback hosts", () => {
    expect(isLocalProviderAuthConnection({ ...prepared, connectionMethod: "direct" })).toBe(true);
    expect(isLocalProviderAuthConnection(prepared)).toBe(true);
    expect(
      isLocalProviderAuthConnection({ ...prepared, httpBaseUrl: "https://remote.example.test" }),
    ).toBe(false);
    expect(isLocalProviderAuthConnection(null)).toBe(false);
  });
  it("uses client callbacks for tunneled hosts even with a loopback gateway", () => {
    expect(isLocalProviderAuthConnection({ ...prepared, connectionMethod: "relay" })).toBe(false);
    expect(isLocalProviderAuthConnection({ ...prepared, connectionMethod: "ssh" })).toBe(false);
  });
});
