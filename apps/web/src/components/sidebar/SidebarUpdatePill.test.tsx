// @vitest-environment jsdom

import type { DesktopUpdateState } from "@supacode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const update = vi.hoisted(() => ({
  state: null as DesktopUpdateState | null,
  install: vi.fn(),
  download: vi.fn(),
  check: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("../../state/desktopUpdate", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useDesktopUpdateState: () =>
      useSyncExternalStore(
        (listener) => {
          update.listeners.add(listener);
          return () => {
            update.listeners.delete(listener);
          };
        },
        () => update.state,
      ),
  };
});
vi.mock("../../state/desktopUpdateRestart", () => ({
  desktopUpdateRestart: { install: update.install },
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => true }));

import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  shouldUseSidebarUpdateReleaseNotesPopover,
  SidebarUpdatePill,
} from "./SidebarUpdatePill";

const nightlyState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible nightly release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, nightlyState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, nightlyState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        channel: "latest",
      }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        releaseNotes: [],
      }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Tab", shiftKey: false, preventDefault };

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "nightly-release-notes");

    expect(open).toHaveBeenCalledWith("nightly-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not promote backward Tab", () => {
    const open = vi.fn();

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "nightly-release-notes",
    );

    expect(open).not.toHaveBeenCalled();
  });
});

describe("sidebar update confirmation", () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = () => act(() => root.render(<SidebarUpdatePill />));
  const button = () => container.querySelector("button")!;
  const press = (at: number) => {
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "timeStamp", { value: at + 1 });
    return act(async () => {
      button().dispatchEvent(event);
    });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    update.state = {
      ...nightlyState,
      channel: "latest",
      status: "downloaded",
      downloadedVersion: nightlyState.availableVersion,
    };
    update.install.mockReset().mockResolvedValue(undefined);
    update.download
      .mockReset()
      .mockResolvedValue({ accepted: true, completed: false, state: nightlyState });
    update.check.mockReset().mockResolvedValue({ checked: true, state: nightlyState });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { downloadUpdate: update.download, checkForUpdate: update.check },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete window.desktopBridge;
    vi.unstubAllGlobals();
  });

  it.each(["latest", "nightly"] as const)(
    "arms the same %s button and installs only after a deliberate second click",
    async (channel) => {
      update.state = { ...update.state!, channel };
      render();
      const original = button();
      await press(0);
      expect(button()).toBe(original);
      expect(button().getAttribute("aria-label")).toBe("Confirm install and restart");
      expect(update.install).not.toHaveBeenCalled();
      await press(200);
      expect(update.install).not.toHaveBeenCalled();
      await press(500);
      expect(update.install).toHaveBeenCalledOnce();
    },
  );

  it("cancels when Escape is pressed", async () => {
    render();
    await press(0);
    act(() =>
      button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await press(500);
    expect(update.install).not.toHaveBeenCalled();
  });

  it("requires a fresh confirmation if the downloaded version changes", async () => {
    render();
    await press(0);
    act(() => {
      update.state = { ...update.state!, downloadedVersion: "0.0.37" };
      for (const listener of update.listeners) listener();
    });
    await press(500);
    expect(update.install).not.toHaveBeenCalled();
    await press(1000);
    expect(update.install).toHaveBeenCalledOnce();
  });

  it("downloads on the first click", async () => {
    update.state = { ...nightlyState, channel: "latest" };
    render();
    await press(0);
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
  });
});
