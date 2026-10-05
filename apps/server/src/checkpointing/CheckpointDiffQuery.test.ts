import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/supacode/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
        files: [],
      },
    ],
  };
}

function makeLayer(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
        }),
      ),
    ),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = makeLayer({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/supacode/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

const gitUpdate = {
  fromBranch: "refs/heads/main",
  toBranch: "refs/heads/feature",
  fromHead: "a".repeat(40),
  toHead: "b".repeat(40),
  fileCount: 1233,
  additions: 145000,
  deletions: 369000,
};

it.effect.each([false, true])(
  "filters attributed paths unless includeGitChanges=%s",
  (includeGitChanges) => {
    const projection = makeProjection();
    const files = [{ path: 'agent\t"file\n.txt', kind: "modified", additions: 1, deletions: 0 }];
    const checkpoints = [
      {
        ...projection.checkpoints[0]!,
        appRunOrdinal: 1,
        runId: firstRunId,
        ref: CheckpointRef.make("refs/test/first"),
        files: [],
      },
      { ...projection.checkpoints[0]!, files, gitUpdate },
    ];
    const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
      Effect.succeed("selected patch"),
    );
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2, includeGitChanges });
      assert.deepEqual(
        diffCheckpoints.mock.calls[0]?.[0].paths,
        includeGitChanges ? undefined : files.map((file) => file.path),
      );
      assert.equal(diffCheckpoints.mock.calls[0]?.[0].noRenames, true);
    }).pipe(
      Effect.provide(
        makeLayer({ projection: Effect.succeed({ ...projection, checkpoints }), diffCheckpoints }),
      ),
    );
  },
);

it.effect("passes an empty allowlist for a Git-only turn", () => {
  const projection = makeProjection();
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(""),
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
    assert.equal(result.diff, "");
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0].paths, []);
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed({
          ...projection,
          checkpoints: [
            { ...projection.checkpoints[0]!, appRunOrdinal: 1, runId: firstRunId, gitUpdate },
          ],
        }),
        diffCheckpoints,
      }),
    ),
  );
});

it.effect("full-thread diffs union agent paths from every turn and forward the opt-in", () => {
  const projection = makeProjection();
  const files = (path: string) => [{ path, kind: "modified", additions: 1, deletions: 0 }];
  const checkpoints = [
    {
      ...projection.checkpoints[0]!,
      appRunOrdinal: 1,
      runId: firstRunId,
      files: files("first.txt"),
    },
    { ...projection.checkpoints[0]!, files: files("second.txt"), gitUpdate },
  ];
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(
      input.format === "numstat" ? "0\t1\told-name.txt\u00001\t0\tfirst.txt\0" : "patch",
    ),
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.deepEqual(diffCheckpoints.mock.calls[1]?.[0].paths, [
      "first.txt",
      "old-name.txt",
      "second.txt",
    ]);
    yield* query.getFullThreadDiff({ threadId, toTurnCount: 2, includeGitChanges: true });
    assert.isUndefined(diffCheckpoints.mock.calls[2]?.[0].paths);
  }).pipe(
    Effect.provide(
      makeLayer({ projection: Effect.succeed({ ...projection, checkpoints }), diffCheckpoints }),
    ),
  );
});

it.effect("fails open for a range with an unavailable grouped file summary", () => {
  const projection = makeProjection();
  const { files: _files, ...metadata } = projection.checkpoints[0]!;
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("patch"),
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.isUndefined(diffCheckpoints.mock.calls[0]?.[0].paths);
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed({
          ...projection,
          checkpoints: [
            { ...metadata, appRunOrdinal: 1, runId: firstRunId, gitUpdate },
            { ...projection.checkpoints[0]!, gitUpdate },
          ],
        }),
        diffCheckpoints,
      }),
    ),
  );
});
