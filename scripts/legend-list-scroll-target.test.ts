// @effect-diagnostics nodeBuiltinImport:off - exercises the installed list bundles in a synchronous VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const bundles = [
  "react.js",
  "react.mjs",
  "react-native.web.js",
  "react-native.web.mjs",
  "react-native.js",
  "react-native.mjs",
];

// Run the shipped sizing and MVCP logic, with native/browser delivery replaced
// by synchronous state. A scroll target survives the render that removes it.
function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const sections = (
    [
      ["// src/state/getContentInsetEnd.ts", "// src/components/DebugView.tsx"],
      ["// src/utils/getId.ts", "// src/utils/getItemSize.ts"],
      ["// src/utils/getItemSize.ts", "// src/core/calculateOffsetWithOffsetPosition.ts"],
      ["// src/utils/requestAdjust.ts", "// src/utils/getScrollVelocity.ts"],
    ] as const
  ).map(([start, end]) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Missing ${start} in ${bundle}`);
    return source.slice(from, to);
  });
  const data = Array.from({ length: 150 }, (_, index) => `row-${index}`);
  const state = {
    props: {
      data,
      keyExtractor: (item: string) => item,
      estimatedItemSize: 90,
      maintainVisibleContentPosition: { data: true, size: true },
    },
    positions: data.map((_, index) => index * 900),
    indexByKey: new Map(data.map((id, index) => [id, index])),
    idCache: [] as Array<string | null>,
    idsInView: ["row-145", "row-146"],
    didContainersLayout: true,
    totalSize: 150 * 900,
    sizes: new Map<string | null, number>(data.map((id) => [id, 900])),
    sizesKnown: new Map(data.map((id) => [id, 900])),
    averageSizes: {},
    scrollLength: 800,
    scroll: 130_000,
    scrollingTo: undefined as { index: number; viewPosition: number; itemSize: number } | undefined,
    scrollAdjustHandler: { requestAdjust: vi.fn() },
    scheduledWork: { timeout: vi.fn() },
  };
  const values = new Map<string, unknown>([
    ["totalSize", state.totalSize],
    ["readyToRender", true],
  ]);
  const ctx = { state, values, scrollAxisGap: 0 };
  const api = NodeVM.runInNewContext(`${sections.join("\n")}\n({ prepareMVCP, getContentSize })`, {
    IsNewArchitecture: true,
    Platform: {
      OS: bundle.startsWith("react-native.") && !bundle.includes(".web.") ? "ios" : "web",
    },
    peek$: (_ctx: unknown, key: string) => values.get(key),
    set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
  }) as {
    prepareMVCP: (context: typeof ctx, dataChanged: boolean) => (() => void) | undefined;
    getContentSize: (context: typeof ctx) => number;
  };
  return {
    state,
    contentSize: () => api.getContentSize(ctx),
    startEndScroll: () => {
      state.scrollingTo = { index: state.props.data.length - 1, viewPosition: 1, itemSize: 900 };
    },
    removeLast: () => {
      const removed = state.props.data.at(-1)!;
      state.props.data = state.props.data.slice(0, -1);
      state.positions.pop();
      state.indexByKey.delete(removed);
      state.sizes.delete(removed);
      state.sizesKnown.delete(removed);
      state.totalSize -= 900;
      values.set("totalSize", state.totalSize);
    },
    recalculate: (dataChanged = true) => api.prepareMVCP(ctx, dataChanged)?.(),
  };
}

describe.each(bundles)("LegendList scroll target (%s)", (bundle) => {
  it("preserves the list height when an in-flight end target is removed", () => {
    const list = createList(bundle);
    list.startEndScroll();
    list.removeLast();
    list.recalculate();

    expect(list.contentSize()).toBe(149 * 900);
    expect(list.state.scroll).toBe(130_000);
    expect(list.state.sizes.has(null)).toBe(false);
  });

  it("preserves the list height while scrolling with the target still present", () => {
    const list = createList(bundle);
    list.startEndScroll();
    list.recalculate();

    expect(list.contentSize()).toBe(150 * 900);
    expect(list.state.scroll).toBe(130_000);
  });

  it("keeps the visible position when removing a row without an active scroll", () => {
    const list = createList(bundle);
    list.removeLast();
    list.recalculate();

    expect(list.contentSize()).toBe(149 * 900);
    expect(list.state.scroll).toBe(130_000);
  });

  it("still compensates when the retained end target grows during scrolling", () => {
    const list = createList(bundle);
    list.startEndScroll();
    list.state.sizesKnown.set("row-149", 1200);
    list.state.totalSize += 300;
    list.recalculate(false);

    expect(list.contentSize()).toBe(150 * 900 + 300);
    expect(list.state.scroll).toBe(130_300);
    expect(list.state.scrollingTo?.itemSize).toBe(1200);
  });
});
