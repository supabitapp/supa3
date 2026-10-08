// @vitest-environment jsdom

import {
  CodeView,
  hydratePartialDiff,
  parsePatchFiles,
  type CodeViewDiffItem,
} from "@pierre/diffs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const searchUrl = new URL("./components/CodeViewSearch.js", import.meta.resolve("@pierre/diffs"));
const { CodeViewSearch } = (await import(searchUrl.href)) as {
  CodeViewSearch: new (view: ReturnType<typeof createView>) => {
    open(): void;
    close(): void;
    refresh(force?: boolean): void;
    getPanelHeight(): number;
  };
};

const PATCH = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-old
+new
 three
@@ -8,3 +8,3 @@
 eight
-before
+after
 ten
`;

const OLD_CONTENTS = "one\nold\nthree\nfour\nhidden-needle\nsix\nseven\neight\nbefore\nten\n";
const NEW_CONTENTS = OLD_CONTENTS.replace("old\n", "new\n").replace("before\n", "after\n");

function createItem(id: string): CodeViewDiffItem<undefined> {
  return { id, type: "diff", fileDiff: parsePatchFiles(PATCH)[0]!.files[0]!, collapsed: true };
}

function hydrate(item: CodeViewDiffItem<undefined>) {
  hydratePartialDiff("merge", item.fileDiff, {
    oldFile: { name: "a.txt", contents: OLD_CONTENTS },
    newFile: { name: "a.txt", contents: NEW_CONTENTS },
  });
}

function createView(items: CodeViewDiffItem<undefined>[]) {
  const root = document.createElement("div");
  root.tabIndex = 0;
  document.body.append(root);
  return {
    getContainerElement: () => root,
    getStickyHeaderOffset: () => 32,
    getSearchItems: () => items,
    getItem: (id: string) => items.find((item) => item.id === id),
    getFirstVisibleSearchMatchIndex: () => 0,
    loadSearchItem: vi.fn<(id: string) => Promise<void> | undefined>(),
    revealSearchMatch: vi.fn(),
    cancelSearchReveal: vi.fn(),
  };
}

function panel(view: ReturnType<typeof createView>) {
  return view.getContainerElement().querySelector("[data-diffs-search]")!.shadowRoot!;
}

function enterQuery(view: ReturnType<typeof createView>) {
  const input = panel(view).querySelector<HTMLInputElement>("input[data-search]")!;
  input.value = "hidden-needle";
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", vi.fn());
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("diff search hydration", () => {
  it("finds hidden context in a folded file after its contents load", async () => {
    const item = createItem("a");
    const view = createView([item]);
    const loaded = deferred();
    view.loadSearchItem.mockReturnValue(loaded.promise);
    const search = new CodeViewSearch(view);
    search.open();
    enterQuery(view);

    expect(panel(view).querySelector("[data-matches]")?.textContent).toBe("Loading…");
    expect(view.revealSearchMatch).not.toHaveBeenCalled();

    hydrate(item);
    loaded.resolve();
    await loaded.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel(view).querySelector("[data-matches]")?.textContent).toBe("1 of 1");
    expect(view.revealSearchMatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", lineNumber: 5, isContext: true }),
    );
    search.close();
  });

  it("bounds concurrent file loads and includes files appended during search", async () => {
    const items = Array.from({ length: 5 }, (_, index) => createItem(String(index)));
    const view = createView(items);
    const firstBatch = deferred();
    const nextBatch = deferred();
    view.loadSearchItem.mockImplementation((id) =>
      Number(id) < 4 ? firstBatch.promise : nextBatch.promise,
    );
    const search = new CodeViewSearch(view);
    search.open();
    expect(view.loadSearchItem).toHaveBeenCalledTimes(4);

    items.push(createItem("5"));
    search.refresh();
    expect(view.loadSearchItem).toHaveBeenCalledTimes(4);

    firstBatch.resolve();
    await firstBatch.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(view.loadSearchItem.mock.calls.map(([id]) => id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    search.close();
    nextBatch.resolve();
  });

  it("reports unavailable context and ignores completion after closing", async () => {
    const view = createView([createItem("a")]);
    const loaded = deferred();
    view.loadSearchItem.mockReturnValue(loaded.promise);
    const search = new CodeViewSearch(view);
    search.open();
    enterQuery(view);
    loaded.reject(new Error("File contents unavailable"));
    await loaded.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(panel(view).querySelector("[data-matches]")?.textContent).toBe("No results (partial)");

    search.close();
    const retry = deferred();
    view.loadSearchItem.mockReturnValue(retry.promise);
    search.open();
    enterQuery(view);
    search.close();
    retry.resolve();
    await retry.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(view.getContainerElement().querySelector("[data-diffs-search]")).toBeNull();
    expect(view.revealSearchMatch).not.toHaveBeenCalled();
  });

  it("uses the rendered panel height when a narrow panel covers a match", () => {
    const view = createView([]);
    const search = new CodeViewSearch(view);
    search.open();
    const host = view.getContainerElement().querySelector("[data-diffs-search]")!;
    const widget = panel(view).querySelector("[data-editor-widget]")!;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 32, 360, 0));
    vi.spyOn(widget, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 40, 344, 78));

    const visibilityView = {
      search,
      getScrollTargetRect: () => ({ top: 100, height: 20 }),
      getItemTopOffset: () => 0,
      getScrollTop: () => 0,
      getStickyHeaderOffset: () => 32,
      getHeight: () => 400,
    };
    const isScrollTargetInView = Reflect.get(CodeView.prototype, "isScrollTargetInView") as (
      this: typeof visibilityView,
      target: { type: "line"; id: string; lineNumber: number },
    ) => boolean;
    expect(search.getPanelHeight()).toBe(86);
    expect(
      isScrollTargetInView.call(visibilityView, { type: "line", id: "a", lineNumber: 5 }),
    ).toBe(false);

    vi.spyOn(widget, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 40, 344, 30));
    expect(
      isScrollTargetInView.call(visibilityView, { type: "line", id: "a", lineNumber: 5 }),
    ).toBe(true);
    search.close();
  });
});
