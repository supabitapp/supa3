// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RestoreThreadBranchButton } from "./RestoreThreadBranchButton";

let root: Root;
let container: HTMLDivElement;
const onRestore = vi.fn();

const render = (hasUncommittedChanges: boolean) =>
  act(() =>
    root.render(
      <RestoreThreadBranchButton
        branch="feature/thread"
        hasUncommittedChanges={hasUncommittedChanges}
        restoring={false}
        onRestore={onRestore}
      />,
    ),
  );
const button = () => container.querySelector("button")!;
const press = () => act(() => button().click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: 0 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  onRestore.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RestoreThreadBranchButton", () => {
  it("restores a clean checkout on the first press", () => {
    render(false);
    press();
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("asks for a second press before carrying uncommitted changes across", () => {
    render(true);
    press();
    expect(onRestore).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    press();
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("drops a pending confirmation once the checkout is clean", () => {
    render(true);
    press();
    render(false);
    render(true);
    act(() => vi.advanceTimersByTime(500));
    press();
    expect(onRestore).not.toHaveBeenCalled();
  });
});
