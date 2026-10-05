import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  VcsRepositoryIdentity,
} from "@supacode/contracts";
import { CheckpointRef } from "@supacode/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Limit the diff to these repository-root paths. */
  readonly paths?: ReadonlyArray<string>;
}

/** HEAD as recorded in a checkpoint commit. */
export interface VcsCheckpointHead {
  readonly commit: string;
  /** Full ref name, or null when HEAD was detached. */
  readonly branch: string | null;
}

export interface VcsReadCheckpointHeadsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsAttributeCheckpointChangesInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fromHead: string;
  readonly toHead: string;
  /** Commits made at or after this instant are the turn's own work. */
  readonly turnStartedAt: DateTime.Utc;
}

export interface VcsCheckpointFileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface VcsCheckpointChangeAttribution {
  /** Changes HEAD moving does not explain, listed without rename detection. */
  readonly files: ReadonlyArray<VcsCheckpointFileChange>;
  /** Totals for paths whose change is exactly the change between the two HEADs. */
  readonly gitMoved: {
    readonly fileCount: number;
    readonly additions: number;
    readonly deletions: number;
  };
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsCheckpointOps {
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<void, VcsError>;
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  /**
   * Read the HEAD each checkpoint recorded. Missing refs are absent from the map;
   * checkpoints without a recorded HEAD map to null.
   */
  readonly readCheckpointHeads: (
    input: VcsReadCheckpointHeadsInput,
  ) => Effect.Effect<ReadonlyMap<CheckpointRef, VcsCheckpointHead | null>, VcsError>;
  /**
   * Split a checkpoint diff into the turn's own changes and the paths that only
   * followed HEAD. Fails when the history is too large to attribute.
   */
  readonly attributeCheckpointChanges: (
    input: VcsAttributeCheckpointChangesInput,
  ) => Effect.Effect<VcsCheckpointChangeAttribution, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly capabilities: VcsDriverCapabilities;
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, "command">,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly checkpoints?: VcsCheckpointOps;
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
    readonly getDiffPreview?: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, VcsError>;
  }
>()("supacode/vcs/VcsDriver") {}
