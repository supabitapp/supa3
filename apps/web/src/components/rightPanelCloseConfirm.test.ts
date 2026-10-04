import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RightPanelSurface } from "../rightPanelStore";

const { confirmMock } = vi.hoisted(() => ({
  confirmMock: vi.fn<(message: string, options?: unknown) => Promise<boolean>>(),
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: confirmMock } }),
}));

import { confirmRightPanelSurfacesClose } from "./rightPanelCloseConfirm";

const surfaces = [
  {
    id: "terminal:term-1",
    kind: "terminal",
    resourceId: "term-1",
    terminalIds: ["term-1", "term-2"],
    activeTerminalId: "term-1",
  },
  {
    id: "terminal:term-3",
    kind: "terminal",
    resourceId: "term-3",
    terminalIds: ["term-3"],
    activeTerminalId: "term-3",
  },
  { id: "browser:one", kind: "preview", resourceId: "tab-1" },
  { id: "diff", kind: "diff" },
] satisfies RightPanelSurface[];

const terminalLabelsById = new Map([["term-1", "Development server"]]);

describe("right panel bulk close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
  });

  it("asks once before stopping every running terminal in the closed tabs", async () => {
    confirmMock.mockResolvedValue(false);

    await expect(
      confirmRightPanelSurfacesClose(surfaces, {
        desktopByTabId: {},
        terminalLabelsById,
        terminalHasRunningSubprocessById: new Map([
          ["term-1", true],
          ["term-2", false],
          ["term-3", true],
        ]),
      }),
    ).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith(
      [
        "Close 2 terminals?",
        'This stops their running processes and clears their histories: "Development server", "Terminal 3".',
      ].join("\n"),
      { variant: "destructive" },
    );
  });

  it("closes idle terminals without asking", async () => {
    await expect(
      confirmRightPanelSurfacesClose(surfaces, {
        desktopByTabId: {},
        terminalLabelsById,
        terminalHasRunningSubprocessById: new Map([["term-1", false]]),
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("skips the terminal prompt when closing the agent's browser is declined", async () => {
    confirmMock.mockResolvedValue(false);

    await expect(
      confirmRightPanelSurfacesClose(surfaces, {
        desktopByTabId: { "tab-1": { controller: "agent" } },
        terminalLabelsById,
        terminalHasRunningSubprocessById: new Map([["term-1", true]]),
      }),
    ).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("Close browser while the agent is using it?");
  });
});
