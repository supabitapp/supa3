import { resolveThreadWorkingStartedAt, type EnvironmentThreadShell } from "./models.ts";

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Settled background work keeps counting from the parent run's start while
 * it waits for a wake. Active work retains its start across background wakes. */
export function resolveThreadListDurationStartedAt(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "runtime">,
): string | null {
  const activityStartedAt = resolveThreadWorkingStartedAt(thread);
  if (activityStartedAt !== null || thread.runtime?.status !== "idle") return activityStartedAt;
  return (
    [thread.latestRun?.startedAt, thread.latestRun?.requestedAt].find(
      (timestamp) => timestamp != null && Number.isFinite(Date.parse(timestamp)),
    ) ?? null
  );
}
