import type {
  EnvironmentId,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffResult,
  ThreadId,
} from "@supacode/contracts";

export type CheckpointDiffResult =
  | OrchestrationGetTurnDiffResult
  | OrchestrationGetFullThreadDiffResult;

export interface CheckpointDiffState {
  readonly data: CheckpointDiffResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface CheckpointDiffTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  /** Also show changes a turn's git update brought in. */
  readonly includeGitChanges?: boolean;
  readonly cacheScope?: string | null;
}
