import { describe, expect, it } from "vite-plus/test";

import { shouldAnimateListChange } from "./listChangeMotion";

const base = { previousScope: "all", scope: "all", searching: false };

describe("list change motion", () => {
  it("allows the first pick and last removal in an already mounted detail control", () => {
    expect(
      shouldAnimateListChange({
        ...base,
        previousKeys: [],
        keys: ["attachment"],
        includeEmpty: true,
      }),
    ).toBe(true);
    expect(
      shouldAnimateListChange({
        ...base,
        previousKeys: ["attachment"],
        keys: [],
        includeEmpty: true,
      }),
    ).toBe(true);
    expect(
      shouldAnimateListChange({ ...base, previousKeys: [], keys: [], includeEmpty: true }),
    ).toBe(false);
    expect(
      shouldAnimateListChange({
        ...base,
        previousKeys: [],
        keys: ["attachment"],
        includeEmpty: true,
        scope: "another-draft",
      }),
    ).toBe(false);
  });
  it("connects a shelf toggle and a pin movement", () => {
    expect(
      shouldAnimateListChange({
        ...base,
        previousKeys: ["working", "settled"],
        keys: ["working", "a", "b", "settled"],
      }),
    ).toBe(true);
    expect(shouldAnimateListChange({ ...base, previousKeys: ["a", "b"], keys: ["b", "a"] })).toBe(
      true,
    );
  });
  it("does not animate hydration, content-only updates, or filtering", () => {
    expect(shouldAnimateListChange({ ...base, previousKeys: [], keys: ["a"] })).toBe(false);
    expect(shouldAnimateListChange({ ...base, previousKeys: ["a"], keys: ["a"] })).toBe(false);
    expect(
      shouldAnimateListChange({ ...base, previousKeys: ["a", "b"], keys: ["b"], searching: true }),
    ).toBe(false);
    expect(
      shouldAnimateListChange({ ...base, previousKeys: ["a", "b"], keys: ["b"], scope: "project" }),
    ).toBe(false);
  });
  it("skips bulk expansions and collapses", () => {
    const expanded = ["shelf", ...Array.from({ length: 100 }, (_, index) => `thread-${index}`)];
    expect(shouldAnimateListChange({ ...base, previousKeys: ["shelf"], keys: expanded })).toBe(
      false,
    );
    expect(shouldAnimateListChange({ ...base, previousKeys: expanded, keys: ["shelf"] })).toBe(
      false,
    );
  });
});
