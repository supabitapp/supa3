// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointService.layer.pipe(
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(CheckpointStoreTestLayer),
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "supacode-checkpoint-git-moves-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

// Pre-turn history is old; work during a turn is dated inside it. Dates are
// explicit so attribution never depends on the wall clock.
const BEFORE_TURN = "2020-01-01T00:00:00Z";
const TURN_START = DateTime.makeUnsafe("2024-06-01T12:00:00.000Z");
const DURING_TURN = "2024-06-01T12:00:30Z";
const BETWEEN_TURNS = "2024-06-01T13:00:00Z";
const SECOND_TURN_START = DateTime.makeUnsafe("2024-06-01T14:00:00.000Z");

const SHARED_LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

function sharedText(replacements: Readonly<Record<number, string>> = {}): string {
  return `${SHARED_LINES.map((line, index) => replacements[index + 1] ?? line).join("\n")}\n`;
}

const runGit = Effect.fn("CheckpointGitMovesTest.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly date?: string; readonly allowNonZeroExit?: boolean } = {},
) {
  const process = yield* VcsProcess.VcsProcess;
  const date = options.date ?? BEFORE_TURN;
  const result = yield* process.run({
    operation: "CheckpointGitMovesTest.git",
    command: "git",
    cwd,
    args,
    // Ambient settings such as merge.ff=only would change what these steps do.
    env: {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    timeoutMs: 20_000,
    ...(options.allowNonZeroExit === true ? { allowNonZeroExit: true } : {}),
  });
  return result.stdout.trim();
});

const writeFile = Effect.fn("CheckpointGitMovesTest.writeFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string | Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const filePath = NodePath.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(NodePath.dirname(filePath), { recursive: true });
  if (typeof contents === "string") yield* fileSystem.writeFileString(filePath, contents);
  else yield* fileSystem.writeFile(filePath, contents);
});

const commitAll = (cwd: string, message: string, date = BEFORE_TURN) =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--quiet", "-m", message], { date });
  });

/** A repo on `main` holding README.md and a 20-line shared.txt. */
const makeRepo = Effect.fn("CheckpointGitMovesTest.makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkpoint-git-moves-" });
  yield* runGit(cwd, ["init", "--quiet", "--initial-branch=main"]);
  yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test"]);
  yield* writeFile(cwd, "README.md", "# test\n");
  yield* writeFile(cwd, "shared.txt", sharedText());
  yield* commitAll(cwd, "base");
  return cwd;
});

function makeScope(cwd: string): OrchestrationV2CheckpointScope {
  return {
    id: CheckpointScopeId.make("scope:checkpoint-git-moves"),
    threadId: ThreadId.make("thread:checkpoint-git-moves"),
    runId: RunId.make("run:checkpoint-git-moves"),
    nodeId: NodeId.make("node:checkpoint-git-moves"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:checkpoint-git-moves"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd,
    createdAt: TURN_START,
  };
}

/** Captures the turn-start baseline (ordinal 0) the way a thread's first run does. */
const startThread = Effect.fn("CheckpointGitMovesTest.startThread")(function* (cwd: string) {
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const scope = makeScope(cwd);
  yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
  return scope;
});

const endTurn = Effect.fn("CheckpointGitMovesTest.endTurn")(function* (
  scope: OrchestrationV2CheckpointScope,
  ordinal = 1,
  turnStartedAt = TURN_START,
) {
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  return yield* checkpoints.capture({
    scope,
    runId: scope.runId,
    nodeId: scope.nodeId,
    ordinalWithinScope: ordinal,
    appRunOrdinal: ordinal,
    turnStartedAt,
    capturedAt: turnStartedAt,
  });
});

const paths = (checkpoint: OrchestrationV2Checkpoint) => checkpoint.files.map((file) => file.path);

it.layer(TestLayer)("checkpoint git move attribution", (it) => {
  it.effect("lists every change as today when HEAD did not move", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      const head = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      const scope = yield* startThread(cwd);
      yield* writeFile(cwd, "README.md", "# changed\n");
      yield* writeFile(cwd, "new.txt", "new\n");

      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(checkpoint.files, [
        { path: "new.txt", kind: "modified", additions: 1, deletions: 0 },
        { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
      ]);
      assert.isUndefined(checkpoint.gitUpdate);
      assert.strictEqual(
        yield* runGit(cwd, ["log", "-1", "--format=%s", checkpoint.ref]),
        `supacode checkpoint ref=${checkpoint.ref} head=${head} branch=refs/heads/main`,
      );
    }),
  );

  it.effect("groups a branch checkout the agent ran", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      const mainHead = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
      yield* writeFile(cwd, "feature.txt", "one\ntwo\nthree\n");
      yield* writeFile(cwd, "shared.txt", sharedText({ 5: "five" }));
      yield* commitAll(cwd, "feature work");
      const featureHead = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      const scope = yield* startThread(cwd);

      yield* writeFile(cwd, "agent.txt", "agent\n");
      yield* runGit(cwd, ["checkout", "--quiet", "feature"]);
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(checkpoint.files, [
        { path: "agent.txt", kind: "modified", additions: 1, deletions: 0 },
      ]);
      assert.deepEqual(checkpoint.gitUpdate, {
        fromBranch: "main",
        toBranch: "feature",
        fromHead: mainHead,
        toHead: featureHead,
        fileCount: 2,
        additions: 4,
        deletions: 1,
      });
    }),
  );

  it.effect("groups a fast-forward pull", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "upstream"]);
      yield* writeFile(cwd, "upstream-1.txt", "one\n");
      yield* commitAll(cwd, "upstream 1");
      yield* writeFile(cwd, "shared.txt", sharedText({ 20: "twenty" }));
      yield* commitAll(cwd, "upstream 2");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      const scope = yield* startThread(cwd);

      yield* writeFile(cwd, "README.md", "# agent edit\n");
      yield* runGit(cwd, ["merge", "--quiet", "--ff-only", "upstream"]);
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["README.md"]);
      assert.include(checkpoint.gitUpdate, {
        fromBranch: "main",
        toBranch: "main",
        fileCount: 2,
      });
    }),
  );

  it.effect("keeps every change a commit made during the turn", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      const scope = yield* startThread(cwd);

      yield* writeFile(cwd, "shared.txt", sharedText({ 3: "three" }));
      yield* commitAll(cwd, "agent commit", DURING_TURN);
      yield* writeFile(cwd, "notes.txt", "notes\n");
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["notes.txt", "shared.txt"]);
      assert.isUndefined(checkpoint.gitUpdate);
    }),
  );

  it.effect("keeps changes folded into an amended commit", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* writeFile(cwd, "shared.txt", sharedText({ 7: "seven" }));
      yield* commitAll(cwd, "previous work");
      const scope = yield* startThread(cwd);

      // The amend keeps the old author date; only the committer date is fresh.
      yield* writeFile(cwd, "extra.txt", "extra\n");
      yield* runGit(cwd, ["add", "extra.txt"]);
      yield* runGit(cwd, ["commit", "--quiet", "--amend", "--no-edit"], { date: DURING_TURN });
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["extra.txt"]);
      assert.isUndefined(checkpoint.gitUpdate);
    }),
  );

  it.effect("keeps rebased commits and groups the upstream changes", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
      yield* writeFile(cwd, "feature.txt", "feature\n");
      yield* writeFile(cwd, "shared.txt", sharedText({ 2: "two-feature" }));
      yield* commitAll(cwd, "feature work");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      yield* writeFile(cwd, "upstream.txt", "upstream\n");
      yield* writeFile(cwd, "shared.txt", sharedText({ 19: "nineteen-main" }));
      yield* commitAll(cwd, "upstream work");
      yield* runGit(cwd, ["checkout", "--quiet", "feature"]);
      const scope = yield* startThread(cwd);

      yield* runGit(cwd, ["rebase", "--quiet", "main"], { date: DURING_TURN });
      const checkpoint = yield* endTurn(scope);

      // The rebased commit rewrote shared.txt, so that merge result is the agent's.
      assert.deepEqual(paths(checkpoint), ["shared.txt"]);
      assert.include(checkpoint.gitUpdate, {
        fromBranch: "feature",
        toBranch: "feature",
        fileCount: 1,
      });
    }),
  );

  it.effect("keeps only the hand-resolved paths of a merge", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* writeFile(cwd, "conflict.txt", sharedText());
      yield* commitAll(cwd, "add conflict.txt");
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
      yield* writeFile(cwd, "conflict.txt", sharedText({ 10: "ten-feature" }));
      yield* writeFile(cwd, "shared.txt", sharedText({ 2: "two-feature" }));
      yield* writeFile(cwd, "theirs.txt", "theirs\n");
      yield* commitAll(cwd, "feature work");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      yield* writeFile(cwd, "conflict.txt", sharedText({ 10: "ten-main" }));
      yield* writeFile(cwd, "shared.txt", sharedText({ 19: "nineteen-main" }));
      yield* commitAll(cwd, "main work");
      const scope = yield* startThread(cwd);

      yield* runGit(cwd, ["merge", "--quiet", "feature"], {
        date: DURING_TURN,
        allowNonZeroExit: true,
      });
      yield* writeFile(cwd, "conflict.txt", sharedText({ 10: "ten-resolved" }));
      yield* runGit(cwd, ["add", "conflict.txt"]);
      yield* runGit(cwd, ["commit", "--quiet", "--no-edit"], { date: DURING_TURN });
      const checkpoint = yield* endTurn(scope);

      // shared.txt merged cleanly and theirs.txt came from feature unchanged.
      assert.deepEqual(paths(checkpoint), ["conflict.txt"]);
      assert.include(checkpoint.gitUpdate, {
        fromBranch: "main",
        toBranch: "main",
        fileCount: 2,
      });
    }),
  );

  it.effect("keeps a dirty edit carried across a checkout", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
      yield* writeFile(cwd, "feature.txt", "feature\n");
      yield* commitAll(cwd, "feature work");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      const scope = yield* startThread(cwd);

      yield* writeFile(cwd, "shared.txt", sharedText({ 4: "four" }));
      yield* runGit(cwd, ["checkout", "--quiet", "feature"]);
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["shared.txt"]);
      assert.include(checkpoint.gitUpdate, { toBranch: "feature", fileCount: 1 });
    }),
  );

  it.effect("keeps dirty work a hard reset discarded", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "upstream"]);
      yield* writeFile(cwd, "shared.txt", sharedText({ 1: "one-upstream" }));
      yield* writeFile(cwd, "upstream.txt", "upstream\n");
      yield* commitAll(cwd, "upstream work");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      // Uncommitted work from before the turn, including a path upstream also changed.
      yield* writeFile(cwd, "README.md", "# dirty\n");
      yield* writeFile(cwd, "shared.txt", sharedText({ 1: "one-dirty" }));
      yield* writeFile(cwd, "scratch.txt", "scratch\n");
      const scope = yield* startThread(cwd);

      yield* runGit(cwd, ["reset", "--quiet", "--hard", "upstream"]);
      yield* runGit(cwd, ["clean", "--quiet", "-fd"]);
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["README.md", "scratch.txt", "shared.txt"]);
      assert.include(checkpoint.gitUpdate, { toBranch: "main", fileCount: 1 });
    }),
  );

  it.effect("lists everything after a checkpoint that predates HEAD recording", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
      yield* writeFile(cwd, "feature.txt", "feature\n");
      yield* commitAll(cwd, "feature work");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      const scope = yield* startThread(cwd);
      const baselineRef = CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 0,
      });
      const tree = yield* runGit(cwd, ["rev-parse", `${baselineRef}^{tree}`]);
      const legacy = yield* runGit(cwd, [
        "commit-tree",
        tree,
        "-m",
        `supacode checkpoint ref=${baselineRef}`,
      ]);
      yield* runGit(cwd, ["update-ref", baselineRef, legacy]);

      yield* writeFile(cwd, "agent.txt", "agent\n");
      yield* runGit(cwd, ["checkout", "--quiet", "feature"]);
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["agent.txt", "feature.txt"]);
      assert.isUndefined(checkpoint.gitUpdate);
    }),
  );

  it.effect("groups a pull and a commit the user made between turns", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "upstream"]);
      yield* writeFile(cwd, "upstream.txt", "upstream\n");
      yield* writeFile(cwd, "shared.txt", sharedText({ 12: "twelve" }));
      yield* commitAll(cwd, "upstream work");
      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      const scope = yield* startThread(cwd);
      yield* writeFile(cwd, "turn-1.txt", "one\n");
      const first = yield* endTurn(scope, 1, TURN_START);

      yield* runGit(cwd, ["merge", "--quiet", "--ff-only", "upstream"]);
      yield* writeFile(cwd, "user.txt", "user\n");
      yield* runGit(cwd, ["add", "user.txt"]);
      yield* runGit(cwd, ["commit", "--quiet", "-m", "user work"], { date: BETWEEN_TURNS });
      yield* writeFile(cwd, "turn-2.txt", "two\n");
      const second = yield* endTurn(scope, 2, SECOND_TURN_START);

      assert.deepEqual(paths(first), ["turn-1.txt"]);
      assert.deepEqual(paths(second), ["turn-2.txt"]);
      assert.include(second.gitUpdate, { fromBranch: "main", toBranch: "main", fileCount: 3 });
    }),
  );

  it.effect("lists everything when the previous HEAD commit is gone", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo();
      yield* runGit(cwd, ["checkout", "--quiet", "-b", "side"]);
      yield* writeFile(cwd, "side.txt", "side\n");
      yield* commitAll(cwd, "side work");
      const scope = yield* startThread(cwd);

      yield* runGit(cwd, ["checkout", "--quiet", "main"]);
      yield* runGit(cwd, ["branch", "--quiet", "-D", "side"]);
      yield* runGit(cwd, ["reflog", "expire", "--expire=now", "--all"]);
      yield* runGit(cwd, ["gc", "--quiet", "--prune=now"]);
      yield* writeFile(cwd, "agent.txt", "agent\n");
      const checkpoint = yield* endTurn(scope);

      assert.deepEqual(paths(checkpoint), ["agent.txt", "side.txt"]);
      assert.isUndefined(checkpoint.gitUpdate);
    }),
  );

  describe("turn diffs", () => {
    const diffQueryFor = (input: {
      readonly scope: OrchestrationV2CheckpointScope;
      readonly checkpoint: OrchestrationV2Checkpoint;
      readonly agentFilePaths?: ReadonlyArray<string> | null;
    }) =>
      CheckpointDiffQuery.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [{ id: input.scope.runId!, ordinal: 1, status: "completed" as const }],
                checkpointScopes: [
                  {
                    id: input.scope.id,
                    runId: input.scope.runId,
                    kind: "root_run" as const,
                    cwd: input.scope.cwd,
                  },
                ],
                checkpoints: [
                  {
                    scopeId: input.scope.id,
                    runId: input.scope.runId,
                    appRunOrdinal: 1,
                    status: "ready" as const,
                    ref: input.checkpoint.ref,
                    agentFilePaths:
                      input.agentFilePaths === undefined
                        ? paths(input.checkpoint)
                        : input.agentFilePaths,
                  },
                ],
              }),
          }),
        ),
      );
    const diffHeaders = (diff: string) =>
      diff.split("\n").filter((line) => line.startsWith("diff --git "));

    it.effect("shows only the agent's paths until git changes are requested", () =>
      Effect.gen(function* () {
        const repo = yield* makeRepo();
        // The workspace is a subdirectory, so stored paths must resolve from the root.
        const cwd = NodePath.join(repo, "pkg");
        yield* writeFile(cwd, "moved.txt", "before\n");
        yield* commitAll(repo, "add pkg");
        yield* runGit(repo, ["checkout", "--quiet", "-b", "feature"]);
        yield* writeFile(repo, "outside.txt", "outside\n");
        yield* writeFile(cwd, "moved.txt", "after\n");
        yield* commitAll(repo, "feature work");
        yield* runGit(repo, ["checkout", "--quiet", "main"]);
        const scope = yield* startThread(cwd);

        const trickyPaths = [
          "a b.txt",
          '"quoted".txt',
          "ü-unicode.txt",
          ":colon.txt",
          "star*.txt",
          "tab\there.txt",
        ];
        for (const filePath of trickyPaths) yield* writeFile(cwd, filePath, `${filePath}\n`);
        yield* writeFile(cwd, "image.bin", new Uint8Array([0, 1, 2, 0, 255]));
        // Enough long paths to need several pathspec chunks.
        const manyPaths = Array.from(
          { length: 2_000 },
          (_, index) =>
            `many/a-fairly-long-generated-file-name-${String(index).padStart(4, "0")}.txt`,
        );
        for (const filePath of manyPaths) yield* writeFile(cwd, filePath, "generated\n");
        yield* runGit(repo, ["checkout", "--quiet", "feature"]);
        const checkpoint = yield* endTurn(scope);

        assert.strictEqual(checkpoint.files.length, trickyPaths.length + 1 + manyPaths.length);
        assert.include(checkpoint.gitUpdate, { fileCount: 2 });

        const agentOnly = yield* Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          return yield* query.getFullThreadDiff({ threadId: scope.threadId, toTurnCount: 1 });
        }).pipe(Effect.provide(diffQueryFor({ scope, checkpoint })));
        const agentHeaders = diffHeaders(agentOnly.diff);
        assert.strictEqual(agentHeaders.length, checkpoint.files.length);
        assert.include(agentOnly.diff, "Binary files /dev/null and b/pkg/image.bin differ");
        assert.include(agentOnly.diff, "+++ b/pkg/:colon.txt");
        assert.include(agentOnly.diff, "+++ b/pkg/star*.txt");
        assert.notInclude(agentOnly.diff, "outside.txt");
        assert.notInclude(agentOnly.diff, "pkg/moved.txt");

        const withGit = yield* Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          return yield* query.getFullThreadDiff({
            threadId: scope.threadId,
            toTurnCount: 1,
            includeGitChanges: true,
          });
        }).pipe(Effect.provide(diffQueryFor({ scope, checkpoint })));
        assert.strictEqual(diffHeaders(withGit.diff).length, checkpoint.files.length + 2);
        assert.include(withGit.diff, "+++ b/outside.txt");
        assert.include(withGit.diff, "+++ b/pkg/moved.txt");
      }),
    );

    it.effect("returns an empty diff for a turn that only moved HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
        yield* writeFile(cwd, "feature.txt", "feature\n");
        yield* commitAll(cwd, "feature work");
        yield* runGit(cwd, ["checkout", "--quiet", "main"]);
        const scope = yield* startThread(cwd);
        yield* runGit(cwd, ["checkout", "--quiet", "feature"]);
        const checkpoint = yield* endTurn(scope);
        assert.deepEqual(checkpoint.files, []);
        assert.include(checkpoint.gitUpdate, { fileCount: 1 });

        const result = yield* Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          return yield* query.getFullThreadDiff({ threadId: scope.threadId, toTurnCount: 1 });
        }).pipe(Effect.provide(diffQueryFor({ scope, checkpoint })));
        assert.strictEqual(result.diff, "");
      }),
    );
  });
});
