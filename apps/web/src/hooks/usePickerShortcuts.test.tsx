// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@supacode/shared/keybindings";

import { usePickerShortcuts } from "./usePickerShortcuts";

vi.mock("~/env", () => ({ isElectron: true }));

function Picker(props: Parameters<typeof usePickerShortcuts<string>>[0]) {
  const labels = usePickerShortcuts(props);
  return (
    <div>
      <input aria-label="Search projects" />
      {props.items.map((item) => (
        <div key={item}>
          {item} {labels.get(item)}
        </div>
      ))}
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
const select = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  select.mockClear();
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

async function renderPicker(overrides: Partial<ComponentProps<typeof Picker>> = {}) {
  await act(() =>
    root.render(
      <Picker
        picker="project"
        open
        items={["Alpha", "Beta", "Gamma", "Delta"]}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        onSelect={select}
        {...overrides}
      />,
    ),
  );
  container.querySelector("input")!.focus();
}

function press(key: string, overrides: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  document.activeElement!.dispatchEvent(event);
  return event;
}

describe.each(["project", "host", "branch"] as const)("%s picker shortcuts", (picker) => {
  it("selects a visible choice before a thread shortcut can handle the event", async () => {
    await renderPicker({ picker });
    const threadKeyDown = vi.fn();
    window.addEventListener("keydown", threadKeyDown);
    try {
      expect(press("4").defaultPrevented).toBe(true);
      expect(select).toHaveBeenCalledWith("Delta");
      expect(threadKeyDown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", threadKeyDown);
    }
  });

  it("renumbers filtered choices for both selection and hints", async () => {
    await renderPicker({ picker });
    await renderPicker({ picker, items: ["Gamma", "Alpha"] });
    expect(container.textContent).toContain("Gamma ⌘1");
    expect(container.textContent).toContain("Alpha ⌘2");
    press("1");
    expect(select).toHaveBeenCalledWith("Gamma");
    expect(press("3").defaultPrevented).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("releases shortcuts when the picker closes", async () => {
    await renderPicker({ picker });
    await renderPicker({ picker, open: false });
    expect(press("1").defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("leaves typing, composition, repeats, and the command palette alone", async () => {
    await renderPicker({ picker });
    press("1", { metaKey: false });
    press("1", { repeat: true });
    press("1", { isComposing: true });
    const palette = document.createElement("div");
    palette.setAttribute("data-command-palette", "");
    container.append(palette);
    expect(press("1").defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("uses configured shortcuts and hides hints claimed by another command", async () => {
    await renderPicker({
      picker,
      keybindings: compileResolvedKeybindingsConfig([
        { key: "alt+b", command: `${picker}Picker.jump.2`, when: `${picker}PickerOpen` },
        { key: "mod+1", command: `${picker}Picker.jump.1`, when: `${picker}PickerOpen` },
        { key: "mod+1", command: "chat.newLocal" },
      ]),
    });
    expect(container.textContent).toContain("Beta ⌥B");
    expect(container.textContent).not.toContain("⌘1");
    expect(press("1").defaultPrevented).toBe(false);
    press("b", { metaKey: false, altKey: true });
    expect(select).toHaveBeenCalledWith("Beta");
  });
});
