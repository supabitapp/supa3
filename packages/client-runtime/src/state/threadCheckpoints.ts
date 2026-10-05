import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2CheckpointGitUpdate,
  RunId,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly gitUpdate?: OrchestrationV2CheckpointGitUpdate;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.gitUpdate ? { gitUpdate: checkpoint.gitUpdate } : {}),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

/** Shared wording keeps checkpoint summaries consistent across review surfaces. */
export function formatCheckpointGitUpdate(update: OrchestrationV2CheckpointGitUpdate): string {
  const from = update.fromBranch?.replace(/^refs\/heads\//, "") ?? update.fromHead.slice(0, 8);
  const to = update.toBranch?.replace(/^refs\/heads\//, "") ?? update.toHead.slice(0, 8);
  return `Updated via Git · ${from === to ? to : `${from} → ${to}`} · ${update.fileCount} file${update.fileCount === 1 ? "" : "s"} +${update.additions} −${update.deletions}`;
}
