import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useAttachmentExits, useAttachmentTrayMotion } from "./composerAttachmentMotion";

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function Tray({ initial }: { initial: string[] }) {
  const [ids, setIds] = useState(initial);
  const { trayRef, tray } = useAttachmentTrayMotion("draft", ids, "layout", false);
  const exits = useAttachmentExits(tray, ids, (id) => id);
  return (
    <div ref={trayRef} data-draft={ids.join(" ")}>
      {exits.items.map((id) => (
        <button
          key={id}
          type="button"
          {...exits.presence(id)}
          onClick={() =>
            exits.exit(id, () => setIds((current) => current.filter((other) => other !== id)))
          }
        >
          {id}
        </button>
      ))}
    </div>
  );
}

async function mountTray(initial: string[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const exits = new Map<string, { finished: Promise<void>; finish: () => void }>();
  const exitOf = (id: string) => {
    let exit = exits.get(id);
    if (!exit) {
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      exit = { finished, finish };
      exits.set(id, exit);
    }
    return exit;
  };
  await act(() => {
    renderer = create(<Tray initial={initial} />, {
      createNodeMock: () => ({
        getAnimations: () => [],
        getBoundingClientRect: () => ({ height: 0 }),
        querySelectorAll: () =>
          renderer.root.findAllByType("button").map((button) => {
            const id = button.props["data-composer-attachment"];
            return {
              dataset: { composerAttachment: id },
              getAnimations: () => [{ finished: exitOf(id).finished, effect: null }],
            };
          }),
      }),
    });
  });
  const shown = () =>
    renderer.root
      .findAllByType("button")
      .map((button) => [
        button.props.children,
        button.props["data-ending-style"] === "" && button.props.inert ? "exiting" : "shown",
      ]);
  const remove = (id: string) =>
    act(() => renderer.root.findByProps({ children: id, type: "button" }).props.onClick());
  const draft = () => renderer.root.findByType("div").props["data-draft"];
  const finishExit = (id: string) => act(async () => exitOf(id).finish());
  return { draft, shown, remove, finishExit };
}

it("takes a removed attachment out of the draft at once and plays its exit in place", async () => {
  const tray = await mountTray(["a", "b", "c"]);

  await tray.remove("b");
  expect(tray.draft()).toBe("a c");
  expect(tray.shown()).toEqual([
    ["a", "shown"],
    ["b", "exiting"],
    ["c", "shown"],
  ]);

  await tray.finishExit("b");
  expect(tray.shown()).toEqual([
    ["a", "shown"],
    ["c", "shown"],
  ]);
});

it("keeps overlapping exits in their places", async () => {
  const tray = await mountTray(["a", "b", "c", "d"]);

  await tray.remove("c");
  await tray.remove("b");
  expect(tray.draft()).toBe("a d");
  expect(tray.shown()).toEqual([
    ["a", "shown"],
    ["b", "exiting"],
    ["c", "exiting"],
    ["d", "shown"],
  ]);

  await tray.finishExit("b");
  expect(tray.shown()).toEqual([
    ["a", "shown"],
    ["c", "exiting"],
    ["d", "shown"],
  ]);
});
