import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  dispatchHardwareKeyboardCommand,
  getRegisteredHardwareKeyboardCommands,
  useHardwareKeyboardCommand,
  useThreadFindFocusBlocker,
  isThreadChatPath,
  nativeHardwareKeyboardCommandsForPath,
  requestThreadFindOnFocus,
  takeThreadFindOnFocus,
} from "./hardwareKeyboardCommands";
import { EnvironmentId, ThreadId } from "@supacode/contracts";

let renderer: ReactTestRenderer | undefined;
let searchFocus: ReturnType<typeof useThreadFindFocusBlocker>;
let calls = 0;
const onFind = () => {
  calls += 1;
};
function Probe(props: { focused: boolean; sidebarVisible: boolean }) {
  useHardwareKeyboardCommand("threadFind", onFind, props.focused);
  const focus = useThreadFindFocusBlocker(props.sidebarVisible);
  useLayoutEffect(() => {
    searchFocus = focus;
  });
  return null;
}
async function render(focused: boolean, sidebarVisible = true) {
  await act(async () => {
    if (renderer) renderer.update(<Probe focused={focused} sidebarVisible={sidebarVisible} />);
    else renderer = create(<Probe focused={focused} sidebarVisible={sidebarVisible} />);
  });
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  calls = 0;
  vi.unstubAllGlobals();
});

describe("mobile thread find keyboard focus", () => {
  it("leaves a retained chat inactive while a pushed route owns focus, then restores it", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await render(true);
    expect(dispatchHardwareKeyboardCommand("threadFind")).toBe(true);
    await render(false);
    expect(getRegisteredHardwareKeyboardCommands().has("threadFind")).toBe(false);
    expect(dispatchHardwareKeyboardCommand("threadFind")).toBe(false);
    await render(true);
    expect(dispatchHardwareKeyboardCommand("threadFind")).toBe(true);
    expect(calls).toBe(2);
  });
  it("removes native find interception while sidebar search owns focus and when the sidebar hides", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await render(true);
    await act(async () => searchFocus.onFocus());
    expect(getRegisteredHardwareKeyboardCommands().has("threadFind")).toBe(false);
    expect(
      nativeHardwareKeyboardCommandsForPath(
        new Set(["focusSearch"]),
        "/threads/env/thread/terminal",
      ).has("focusSearch"),
    ).toBe(true);
    // Palette/header actions remain able to request chat find deliberately.
    expect(dispatchHardwareKeyboardCommand("threadFind")).toBe(true);
    await render(true, false);
    expect(getRegisteredHardwareKeyboardCommands().has("threadFind")).toBe(true);
  });
  it.each([
    "/threads/env/thread/terminal",
    "/threads/env/thread/files",
    "/threads/env/thread/review",
    "/settings",
  ])("keeps native chat find out of %s", (path) => {
    expect(isThreadChatPath(path)).toBe(false);
  });
  it("hands a palette find request to the matching chat once it receives focus", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    requestThreadFindOnFocus(ref);
    expect(takeThreadFindOnFocus({ ...ref, threadId: ThreadId.make("another") })).toBe(false);
    expect(takeThreadFindOnFocus(ref)).toBe(true);
    expect(takeThreadFindOnFocus(ref)).toBe(false);
    expect(isThreadChatPath("/threads/env/thread")).toBe(true);
  });
});
