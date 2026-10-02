import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export interface TerminalCloseTarget {
  readonly label: string;
  readonly hasRunningSubprocess: boolean;
}

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, the `terminal.close` keybinding, and closing a terminal surface from
 * the tab strip. Auto-exit cleanup and bulk tab closes skip this path and close
 * directly.
 */
export async function confirmTerminalClose(
  targets: readonly [TerminalCloseTarget, ...TerminalCloseTarget[]],
): Promise<boolean> {
  const runningTargets = targets.filter((target) => target.hasRunningSubprocess);
  if (runningTargets.length === 0) return true;

  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      runningTargets.length === 1
        ? [
            `Close terminal "${runningTargets[0]!.label}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${runningTargets.length} terminals?`,
            `This stops their running processes and clears their histories: ${runningTargets
              .map((target) => `"${target.label}"`)
              .join(", ")}.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
