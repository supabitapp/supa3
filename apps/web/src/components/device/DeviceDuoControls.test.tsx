import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { DuoCommand } from "@supacode/client-runtime/device/duo-control";
import type { DeviceScreenSize } from "@supacode/client-runtime/device/stream";
import { DeviceDuoControls } from "./DeviceDuoControls";

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const stands = [
  { vertical: true, screenId: 3, hingePose: "laptop", hingeAngle: 90, restore: "landscape_left" },
  {
    vertical: false,
    screenId: 3,
    hingePose: "laptop",
    hingeAngle: 90,
    restore: "portrait_upside_down",
  },
  { vertical: true, screenId: 1, hingePose: "tent", hingeAngle: 80, restore: "portrait" },
  { vertical: false, screenId: 1, hingePose: "tent", hingeAngle: 80, restore: "landscape_left" },
] as const;

it.each(stands)(
  "restores a $vertical vertical hold after another client enters $hingePose",
  async ({ vertical, screenId, hingePose, hingeAngle, restore }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onCommand = vi.fn<(command: DuoCommand) => void>();
    const view = (screen: DeviceScreenSize) => (
      <DeviceDuoControls
        screen={screen}
        state={{ pending: false, requested: null, error: null }}
        enabled
        onCommand={onCommand}
      />
    );
    const cover = { width: 1398, height: 2034, screenId: 1, hingeAngle: 0 };
    await act(async () => {
      renderer = create(view({ ...cover, orientation: vertical ? "landscape_left" : "portrait" }));
    });
    await act(async () =>
      renderer!.update(view({ ...cover, orientation: vertical ? "portrait" : "landscape_left" })),
    );
    await act(async () =>
      renderer!.update(
        view({
          width: screenId === 1 ? 1398 : 2007,
          height: screenId === 1 ? 2034 : 2853,
          orientation: "portrait",
          screenId,
          hingePose,
          hingeAngle,
        }),
      ),
    );
    for (const [label, angle] of [
      ["Closed", 0],
      [vertical ? "Book" : "Laptop", 90],
      ["Open", 180],
    ] as const) {
      const button = renderer!.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === label);
      expect(button).toBeDefined();
      await act(async () => button!.props.onClick());
      expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
        { control: "orientation", value: restore },
        { control: "angle", value: angle },
      ]);
      onCommand.mockClear();
    }
  },
);
