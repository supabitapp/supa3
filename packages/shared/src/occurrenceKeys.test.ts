import { describe, expect, it } from "vite-plus/test";

import { withOccurrenceKeys } from "./occurrenceKeys.ts";

describe("withOccurrenceKeys", () => {
  it("numbers repeated identities in order", () => {
    expect(withOccurrenceKeys(["a", "b", "a", "a"], (value) => value)).toEqual([
      { item: "a", key: "a:0" },
      { item: "b", key: "b:0" },
      { item: "a", key: "a:1" },
      { item: "a", key: "a:2" },
    ]);
  });

  it("keeps a key stable when items are appended", () => {
    const before = withOccurrenceKeys(["x", "y"], (value) => value).map(({ key }) => key);
    const after = withOccurrenceKeys(["x", "y", "x"], (value) => value).map(({ key }) => key);
    expect(after.slice(0, 2)).toEqual(before);
  });
});
