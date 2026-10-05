import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export interface TerminalCloseTarget {
  readonly label: string;
  readonly hasRunningSubprocess: boolean;
}

/** Whether a close confirmation from this module is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmClose(message: string) {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(message, { variant: "destructive" });
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}

/**
 * Confirmation for terminal close actions: drawer buttons, panel buttons, the
 * `terminal.close` keybinding, and closing terminal surfaces from the tab strip,
 * one at a time or in bulk. Auto-exit cleanup skips this path and closes
 * directly.
 */
export async function confirmTerminalClose(
  targets: readonly TerminalCloseTarget[],
): Promise<boolean> {
  const runningTargets = targets.filter((target) => target.hasRunningSubprocess);
  if (runningTargets.length === 0) return true;

  return confirmClose(
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
  );
}
