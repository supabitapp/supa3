import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type HostResourcesSnapshot } from "@supacode/contracts";
import { Effect } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serverEnvironment } from "../state/server";
import { useLoadBalancedEnvironment } from "./useLoadBalancedEnvironment";

vi.mock("../state/server", () => ({ serverEnvironment: { hostResources: vi.fn() } }));

const environmentId = EnvironmentId.make("machine");
const ids = [environmentId];
const weights = {};
const healthy: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0.3,
  cpuCount: 12,
  availableMemoryBytes: 20_000,
  totalMemoryBytes: 32_000,
};
let response: HostResourcesSnapshot | Error;
let reads = 0;
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let selection: ReturnType<typeof useLoadBalancedEnvironment> | undefined;

function Probe() {
  const value = useLoadBalancedEnvironment(ids, weights);
  useLayoutEffect(() => {
    selection = value;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  reads = 0;
  selection = undefined;
  vi.mocked(serverEnvironment.hostResources).mockReturnValue(
    Atom.make(
      Effect.suspend(() => {
        reads++;
        return response instanceof Error ? Effect.fail(response) : Effect.succeed(response);
      }),
    ).pipe(Atom.setIdleTTL(0)),
  );
});

afterEach(async () => {
  await act(() => renderer.unmount());
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  ["CPU saturation", { ...healthy, cpuUtilization: 0.98 }],
  ["memory pressure", { ...healthy, availableMemoryBytes: 1_000 }],
  ["failed checks", new Error("Resource check timed out")],
] as const)(
  "selects a recovered machine after %s without reopening the draft",
  async (_, initial) => {
    response = initial;
    await act(() => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
    });
    expect(selection?.environmentId).toBeNull();
    response = healthy;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(selection?.environmentId).toBe(environmentId);
    expect(reads).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(reads).toBe(2);
  },
);
