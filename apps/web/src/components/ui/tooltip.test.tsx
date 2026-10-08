// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function keyboard(type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}) {
  await act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key, ...init }));
  });
}

function hints() {
  return Array.from(document.querySelectorAll('[data-slot="shortcut-hint"]')).map(
    (element) => element.textContent,
  );
}

async function renderActions(extra = false) {
  await act(() => {
    root.render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>New thread</TooltipTrigger>
          <TooltipPopup shortcut="⌘N">New thread</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>Search</TooltipTrigger>
          <TooltipPopup shortcut="⌘K">Search</TooltipPopup>
        </Tooltip>
        {extra ? (
          <Tooltip>
            <TooltipTrigger>Model</TooltipTrigger>
            <TooltipPopup shortcut="⇧⌘M">Model</TooltipPopup>
          </Tooltip>
        ) : null}
      </TooltipProvider>,
    );
  });
}

describe("shortcut hints", () => {
  it("reveals all action shortcuts together and hides them on release", async () => {
    await renderActions();
    expect(hints()).toEqual([]);
    await keyboard("keydown", "Meta", { metaKey: true });
    expect(hints()).toEqual(["⌘N", "⌘K"]);
    await keyboard("keydown", "Shift", { metaKey: true, shiftKey: true });
    expect(hints()).toEqual(["⌘N", "⌘K"]);
    await keyboard("keyup", "Meta", { shiftKey: true });
    expect(hints()).toEqual([]);
  });

  it("reveals actions mounted while Command is already held", async () => {
    await renderActions();
    await keyboard("keydown", "Meta", { metaKey: true });
    await renderActions(true);
    expect(hints()).toEqual(["⌘N", "⌘K", "⇧⌘M"]);
  });

  it.each(["Win32", "Linux x86_64"])("uses Control on %s", async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await renderActions();
    await keyboard("keydown", "Meta", { metaKey: true });
    expect(hints()).toEqual([]);
    await keyboard("keyup", "Meta");
    await keyboard("keydown", "Control", { ctrlKey: true });
    expect(hints()).toEqual(["⌘N", "⌘K"]);
    await keyboard("keyup", "Control");
    expect(hints()).toEqual([]);
  });

  it.each(["blur", "paste"])(
    "clears hints on %s without reviving from stale flags",
    async (reset) => {
      await renderActions();
      await keyboard("keydown", "Meta", { metaKey: true });
      await act(() => window.dispatchEvent(new Event(reset)));
      await keyboard("keydown", "Enter", { metaKey: true });
      expect(hints()).toEqual([]);
    },
  );

  it("omits unavailable actions and preserves the caller's trigger ref", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    await act(() => {
      root.render(
        <>
          <Tooltip>
            <TooltipTrigger ref={triggerRef}>Search</TooltipTrigger>
            <TooltipPopup shortcut="⌘K">Search</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <button disabled>Disabled action</button>
            </TooltipTrigger>
            <TooltipPopup shortcut="⌘N">Disabled action</TooltipPopup>
          </Tooltip>
          <Tooltip disabled>
            <TooltipTrigger>Unavailable tooltip</TooltipTrigger>
            <TooltipPopup shortcut="⌘O">Unavailable tooltip</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>Unbound action</TooltipTrigger>
            <TooltipPopup>Unbound action</TooltipPopup>
          </Tooltip>
        </>,
      );
    });
    expect(triggerRef.current?.textContent).toBe("Search");
    await keyboard("keydown", "Meta", { metaKey: true });
    expect(hints()).toEqual(["⌘K"]);
    await act(async () => {
      triggerRef.current!.disabled = true;
    });
    expect(hints()).toEqual([]);
    await act(async () => {
      triggerRef.current!.disabled = false;
    });
    expect(hints()).toEqual(["⌘K"]);
  });
});
