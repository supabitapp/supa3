import { EnvironmentId } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveOnboardingSetup } from "./targetEnvironment.logic";

const connectedId = EnvironmentId.make("connected");
const otherId = EnvironmentId.make("other");
const selected = new Set([connectedId, otherId]);
const connected = { environmentId: connectedId, connection: { phase: "connected" } };

describe("onboarding connection selection", () => {
  it.each(["offline", "available", "unsupported", "error", "reconnecting"])(
    "continues with the connected machine while a selected machine is %s",
    (phase) => {
      expect(
        resolveOnboardingSetup(
          [connected, { environmentId: otherId, connection: { phase } }],
          selected,
        ),
      ).toEqual({ ready: true, environmentIds: [connectedId], skippedIds: [otherId] });
    },
  );

  it("waits for the first connection attempt and admits the machine once it connects", () => {
    const pending = { environmentId: otherId, connection: { phase: "connecting" } };
    expect(resolveOnboardingSetup([connected, pending], selected).ready).toBe(false);
    expect(
      resolveOnboardingSetup(
        [connected, { ...pending, connection: { phase: "connected" } }],
        selected,
      ),
    ).toEqual({ ready: true, environmentIds: [connectedId, otherId], skippedIds: [] });
  });

  it("requires a selected connected machine", () => {
    expect(resolveOnboardingSetup([connected], new Set()).ready).toBe(false);
    expect(
      resolveOnboardingSetup(
        [{ environmentId: otherId, connection: { phase: "offline" } }],
        selected,
      ).ready,
    ).toBe(false);
  });
});
