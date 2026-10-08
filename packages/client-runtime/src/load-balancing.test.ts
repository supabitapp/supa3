import { describe, expect, it } from "vite-plus/test";
import {
  chooseLoadBalancedEnvironment,
  inspectLoadBalancedEnvironments,
} from "./load-balancing.ts";

const now = 10_000;
const healthy = {
  environmentId: "machine",
  weight: 50,
  receivedAt: now,
  resources: {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  },
};

describe("automatic machine resource status", () => {
  it("distinguishes missing candidates, failed readings and saturation", () => {
    expect(inspectLoadBalancedEnvironments([], now).status).toBe("no-candidates");
    expect(inspectLoadBalancedEnvironments([{ ...healthy, weight: 0 }], now).status).toBe(
      "no-candidates",
    );
    expect(inspectLoadBalancedEnvironments([{ ...healthy, resources: null }], now).status).toBe(
      "unavailable",
    );
    expect(inspectLoadBalancedEnvironments([healthy], now + 15_001).status).toBe("unavailable");
    expect(
      inspectLoadBalancedEnvironments(
        [{ ...healthy, resources: { ...healthy.resources, cpuUtilization: 0.95 } }],
        now,
      ).status,
    ).toBe("at-capacity");
    expect(
      inspectLoadBalancedEnvironments(
        [{ ...healthy, resources: { ...healthy.resources, availableMemoryBytes: 800 } }],
        now,
      ).status,
    ).toBe("at-capacity");
  });
  it("selects a recovered machine and preserves the existing chooser API", () => {
    expect(chooseLoadBalancedEnvironment([healthy], now)).toBe("machine");
    expect(
      inspectLoadBalancedEnvironments(
        [healthy, { ...healthy, environmentId: "unknown", resources: null }],
        now,
      ),
    ).toEqual({ environmentId: "machine", status: "selected" });
  });
  it("does not claim all machines are busy when a reading is missing", () => {
    expect(
      inspectLoadBalancedEnvironments(
        [
          { ...healthy, resources: { ...healthy.resources, cpuUtilization: 1 } },
          { ...healthy, resources: null },
        ],
        now,
      ).status,
    ).toBe("unavailable");
  });
});
