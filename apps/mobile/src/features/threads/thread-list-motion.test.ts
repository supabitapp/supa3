import { describe, expect, it } from "vite-plus/test";

import { shouldAnimateThreadList } from "./thread-list-motion";

const base = { previousScope: "all", scope: "all", searching: false };

describe("thread list motion", () => {
  it("connects a shelf toggle and a pin movement", () => {
    expect(
      shouldAnimateThreadList({
        ...base,
        previousKeys: ["working", "settled"],
        keys: ["working", "a", "b", "settled"],
      }),
    ).toBe(true);
    expect(shouldAnimateThreadList({ ...base, previousKeys: ["a", "b"], keys: ["b", "a"] })).toBe(
      true,
    );
  });
  it("does not animate hydration, content-only updates, or filtering", () => {
    expect(shouldAnimateThreadList({ ...base, previousKeys: [], keys: ["a"] })).toBe(false);
    expect(shouldAnimateThreadList({ ...base, previousKeys: ["a"], keys: ["a"] })).toBe(false);
    expect(
      shouldAnimateThreadList({ ...base, previousKeys: ["a", "b"], keys: ["b"], searching: true }),
    ).toBe(false);
    expect(
      shouldAnimateThreadList({ ...base, previousKeys: ["a", "b"], keys: ["b"], scope: "project" }),
    ).toBe(false);
  });
  it("skips bulk expansions and collapses", () => {
    const expanded = ["shelf", ...Array.from({ length: 100 }, (_, index) => `thread-${index}`)];
    expect(shouldAnimateThreadList({ ...base, previousKeys: ["shelf"], keys: expanded })).toBe(
      false,
    );
    expect(shouldAnimateThreadList({ ...base, previousKeys: expanded, keys: ["shelf"] })).toBe(
      false,
    );
  });
});
