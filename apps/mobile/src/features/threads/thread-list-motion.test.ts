import { describe, expect, it } from "vite-plus/test";

import { shouldAnimateThreadList } from "./thread-list-motion";

const base = {
  previousScope: "all",
  scope: "all",
  searching: false,
  previousSettledLimit: 10,
  settledLimit: 10,
};

const rows = (...keys: string[]) => keys.map((key) => ({ key }));

describe("thread list motion", () => {
  it("connects a shelf toggle and a pin movement", () => {
    expect(
      shouldAnimateThreadList({
        ...base,
        previousItems: rows("working", "settled"),
        items: rows("working", "a", "b", "settled"),
      }),
    ).toBe(true);
    expect(
      shouldAnimateThreadList({ ...base, previousItems: rows("a", "b"), items: rows("b", "a") }),
    ).toBe(true);
  });
  it("does not animate hydration, content-only updates, or filtering", () => {
    expect(shouldAnimateThreadList({ ...base, previousItems: [], items: rows("a") })).toBe(false);
    expect(shouldAnimateThreadList({ ...base, previousItems: rows("a"), items: rows("a") })).toBe(
      false,
    );
    expect(
      shouldAnimateThreadList({
        ...base,
        previousItems: rows("a", "b"),
        items: rows("b"),
        searching: true,
      }),
    ).toBe(false);
    expect(
      shouldAnimateThreadList({
        ...base,
        previousItems: rows("a", "b"),
        items: rows("b"),
        scope: "project",
      }),
    ).toBe(false);
  });
  it("skips bulk data additions and removals", () => {
    const expanded = [
      { key: "shelf", expanded: true },
      ...rows(...Array.from({ length: 100 }, (_, index) => `thread-${index}`)),
    ];
    const empty = [{ key: "shelf", expanded: true }];
    expect(shouldAnimateThreadList({ ...base, previousItems: empty, items: expanded })).toBe(false);
    expect(shouldAnimateThreadList({ ...base, previousItems: expanded, items: empty })).toBe(false);
  });

  it.each([25, 100])("animates expanding and collapsing a shelf with %i rows", (count) => {
    const collapsed = [{ key: "settled", expanded: false }];
    const expanded = [
      { key: "settled", expanded: true },
      ...rows(...Array.from({ length: count }, (_, index) => `thread-${index}`)),
    ];
    expect(shouldAnimateThreadList({ ...base, previousItems: collapsed, items: expanded })).toBe(
      true,
    );
    expect(shouldAnimateThreadList({ ...base, previousItems: expanded, items: collapsed })).toBe(
      true,
    );
  });

  it("keeps shelf toggles immediate during hydration, search, and scope changes", () => {
    const collapsed = [{ key: "settled", expanded: false }];
    const expanded = [{ key: "settled", expanded: true }, ...rows("thread")];
    expect(shouldAnimateThreadList({ ...base, previousItems: [], items: expanded })).toBe(false);
    expect(
      shouldAnimateThreadList({
        ...base,
        previousItems: collapsed,
        items: expanded,
        searching: true,
      }),
    ).toBe(false);
    expect(
      shouldAnimateThreadList({
        ...base,
        previousItems: collapsed,
        items: expanded,
        scope: "project",
      }),
    ).toBe(false);
  });

  it("does not treat a new shelf as a toggle", () => {
    expect(
      shouldAnimateThreadList({
        ...base,
        previousItems: rows("active"),
        items: [
          ...rows("active"),
          { key: "settled", expanded: true },
          ...rows(...Array.from({ length: 25 }, (_, index) => `thread-${index}`)),
        ],
      }),
    ).toBe(false);
  });

  it.each([false, true])(
    "animates settled pagination when the show-more button disappears: %s",
    (lastPage) => {
      const previousItems = [
        { key: "settled", expanded: true },
        ...rows(...Array.from({ length: 10 }, (_, index) => `thread-${index}`)),
        ...rows("show-more"),
      ];
      const items = [
        { key: "settled", expanded: true },
        ...rows(...Array.from({ length: 35 }, (_, index) => `thread-${index}`)),
        ...rows(...(lastPage ? [] : ["show-more"])),
      ];
      expect(shouldAnimateThreadList({ ...base, previousItems, items, settledLimit: 35 })).toBe(
        true,
      );
      expect(shouldAnimateThreadList({ ...base, previousItems, items })).toBe(false);
    },
  );

  it("keeps pagination immediate during hydration, search, and scope changes", () => {
    const pagination = {
      ...base,
      previousItems: rows("settled", "show-more"),
      items: rows("settled", ...Array.from({ length: 25 }, (_, index) => `thread-${index}`)),
      settledLimit: 35,
    };
    expect(shouldAnimateThreadList({ ...pagination, previousItems: [] })).toBe(false);
    expect(shouldAnimateThreadList({ ...pagination, searching: true })).toBe(false);
    expect(shouldAnimateThreadList({ ...pagination, scope: "project" })).toBe(false);
  });
});
