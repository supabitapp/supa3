// @vitest-environment jsdom

import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@supacode/shared/keybindings";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "none" }));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

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

async function renderActions(
  overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {},
) {
  await act(() => {
    root.render(
      <ComposerPrimaryActions
        compact
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        canOperateThread
        pendingAction={null}
        isRunning
        canInterrupt
        followUpBehavior="queue"
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        sendDisabledReason={null}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
        {...overrides}
      />,
    );
  });
}

async function command(held: boolean) {
  await act(() => {
    window.dispatchEvent(
      new KeyboardEvent(held ? "keydown" : "keyup", { key: "Meta", metaKey: held }),
    );
  });
}

function hints() {
  return Array.from(document.querySelectorAll('[data-slot="shortcut-hint"]')).map(
    (element) => element.textContent,
  );
}

describe("running composer shortcut hints", () => {
  it.each(["queue", "steer"] as const)(
    "reveals the alternate follow-up when the default is %s",
    async (followUpBehavior) => {
      await renderActions({ followUpBehavior });
      const initialLabel = followUpBehavior === "queue" ? "Queue message" : "Steer message";
      const alternateLabel = followUpBehavior === "queue" ? "Steer message" : "Queue message";
      expect(container.querySelector(`button[aria-label='${initialLabel}']`)).not.toBeNull();
      expect(hints()).toEqual([]);
      await command(true);
      expect(container.querySelector(`button[aria-label='${alternateLabel}']`)).not.toBeNull();
      expect(hints()).toEqual(["↵"]);
      await command(false);
      expect(container.querySelector(`button[aria-label='${initialLabel}']`)).not.toBeNull();
      expect(hints()).toEqual([]);
    },
  );

  it("reveals a configured stop shortcut only while its running condition applies", async () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+alt+.", command: "thread.stop", when: "turnRunning" },
    ]);
    await renderActions({ keybindings, hasSendableContent: false, promptHasText: false });
    expect(container.querySelector("button[aria-label='Stop generation']")).not.toBeNull();
    await command(true);
    expect(hints()).toEqual(["⌥."]);
    await renderActions({ keybindings, isRunning: false, canInterrupt: false });
    expect(container.querySelector("button[aria-label='Stop generation']")).toBeNull();
    expect(hints()).toEqual(["↵"]);
  });

  it("keeps an unbound stop action free of shortcut hints", async () => {
    await renderActions({ hasSendableContent: false, promptHasText: false });
    await command(true);
    expect(container.querySelector("button[aria-label='Stop generation']")).not.toBeNull();
    expect(hints()).toEqual([]);
  });
});
