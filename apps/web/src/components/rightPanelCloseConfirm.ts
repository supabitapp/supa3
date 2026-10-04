import { getTerminalLabel } from "@supacode/shared/terminalLabels";
import { readLocalApi } from "~/localApi";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import type { DesktopPreviewOverlay } from "../previewStateStore";
import type { RightPanelSurface } from "../rightPanelStore";
import { agentControlledBrowserCloseConfirmation } from "./ChatView.logic";

export async function confirmRightPanelSurfacesClose(
  surfaces: readonly RightPanelSurface[],
  context: {
    readonly desktopByTabId: Readonly<
      Record<string, Pick<DesktopPreviewOverlay, "controller"> | undefined>
    >;
    readonly terminalLabelsById: ReadonlyMap<string, string>;
    readonly terminalHasRunningSubprocessById: ReadonlyMap<string, boolean>;
  },
): Promise<boolean> {
  const browserMessage = agentControlledBrowserCloseConfirmation(surfaces, context.desktopByTabId);
  if (browserMessage) {
    const localApi = readLocalApi();
    if (!localApi) return false;
    const confirmed = await localApi.dialogs
      .confirm(browserMessage, { variant: "destructive" })
      .catch(() => false);
    if (!confirmed) return false;
  }
  return confirmTerminalClose(
    surfaces.flatMap((surface) =>
      surface.kind === "terminal"
        ? surface.terminalIds.map((terminalId) => ({
            label: context.terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
            hasRunningSubprocess: context.terminalHasRunningSubprocessById.get(terminalId) ?? false,
          }))
        : [],
    ),
  );
}
