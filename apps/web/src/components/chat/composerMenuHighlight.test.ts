import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("defaults to the first item when nothing is highlighted", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: null,
        currentSearchKey: "skill:u",
        highlightedSearchKey: null,
        defaultToFirst: true,
      }),
    ).toBe("top");
  });

  it("preserves the highlighted item within the same query", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:u",
        highlightedSearchKey: "skill:u",
        defaultToFirst: true,
      }),
    ).toBe("second");
  });

  it("resets to the top result when the query changes", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:u",
        defaultToFirst: true,
      }),
    ).toBe("top");
  });

  it("falls back to the first item when the highlighted item disappears", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "missing",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:ui",
        defaultToFirst: true,
      }),
    ).toBe("top");
  });

  it("waits for an explicit pick when the menu has no default", () => {
    const search = {
      items,
      currentSearchKey: "slash-skill:u",
      highlightedSearchKey: "slash-skill:u",
      defaultToFirst: false,
    };
    expect(resolveComposerMenuActiveItemId({ ...search, highlightedItemId: null })).toBeNull();
    expect(resolveComposerMenuActiveItemId({ ...search, highlightedItemId: "second" })).toBe(
      "second",
    );
  });

  it("clears the active result while async results are empty and resolves against restored results", () => {
    const search = {
      highlightedItemId: "second",
      currentSearchKey: "path:src",
      highlightedSearchKey: "path:src",
      defaultToFirst: true,
    };
    const cleared = resolveComposerMenuActiveItemId({ ...search, items: [] });
    expect(cleared).toBeNull();
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        highlightedItemId: cleared,
        items: [{ id: "new-result" }, { id: "second" }],
      }),
    ).toBe("new-result");
  });
});
