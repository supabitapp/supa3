import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadFeedFixedItemSize,
  threadWorkRowNeedsMeasurement,
} from "./thread-feed-item-size";

describe("resolveThreadFeedFixedItemSize", () => {
  it("leaves activity groups to native measurement", () => {
    expect(resolveThreadFeedFixedItemSize("activity-group")).toBeUndefined();
  });

  it("keeps fixed timeline chrome on the premeasured path", () => {
    expect(resolveThreadFeedFixedItemSize("run-fold")).toBe(42);
    expect(resolveThreadFeedFixedItemSize("work-toggle")).toBe(28);
  });
});

describe("threadWorkRowNeedsMeasurement", () => {
  it("keeps unopened rows on the fixed-size path", () => {
    expect(threadWorkRowNeedsMeasurement("tool", {})).toBe(false);
  });

  it("measures open details and keeps measuring through collapse", () => {
    expect(threadWorkRowNeedsMeasurement("tool", { tool: true })).toBe(true);
    expect(threadWorkRowNeedsMeasurement("tool", { tool: false })).toBe(true);
    expect(threadWorkRowNeedsMeasurement("other", { tool: false })).toBe(false);
  });
});
