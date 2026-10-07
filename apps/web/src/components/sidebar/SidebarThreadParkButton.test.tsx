// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarThreadParkButton } from "./SidebarThreadParkButton";

let root: Root;
let container: HTMLDivElement;

const runningThread = { runtime: { status: "running" as const } };
const idleThread = { runtime: { status: "idle" as const } };
const onSettle = vi.fn();
const onStop = vi.fn();
const onPointerDown = vi.fn();

const render = (thread: typeof runningThread | typeof idleThread) =>
  act(() =>
    root.render(
      <SidebarThreadParkButton
        thread={thread}
        shortcut={null}
        onSettle={onSettle}
        onStop={onStop}
        onPointerDown={onPointerDown}
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
  onSettle.mockClear();
  onStop.mockClear();
  onPointerDown.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SidebarThreadParkButton", () => {
  it("asks before stopping a running thread", () => {
    render(runningThread);

    expect(button().getAttribute("aria-label")).toBe("Settle thread");
    press();
    expect(onStop).not.toHaveBeenCalled();
    expect(button().getAttribute("aria-label")).toBe("Confirm stop thread");

    act(() => vi.advanceTimersByTime(500));
    press();
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("settles an idle thread on the first press", () => {
    render(idleThread);
    press();
    expect(onSettle).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });
});
