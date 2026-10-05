import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointGitUpdate,
  OrchestrationV2ThreadProjection,
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
  /** Changes HEAD brought in during or before the turn, kept out of `files`. */
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
        ...(checkpoint.gitUpdate === undefined ? {} : { gitUpdate: checkpoint.gitUpdate }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

/** "main → feature", one name when the branch stayed put, short commits for a detached HEAD. */
export function formatGitUpdateRefs(gitUpdate: OrchestrationV2CheckpointGitUpdate): string {
  const from = gitUpdate.fromBranch ?? gitUpdate.fromHead.slice(0, 7);
  const to = gitUpdate.toBranch ?? gitUpdate.toHead.slice(0, 7);
  return from === to ? to : `${from} → ${to}`;
}

/** The label every surface shows for a turn's git update. */
export function formatGitUpdateLabel(gitUpdate: OrchestrationV2CheckpointGitUpdate): string {
  return `Updated via Git · ${formatGitUpdateRefs(gitUpdate)}`;
}
