// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

const OLD_DATE = "2020-01-01T00:00:00Z";
const RUN_DATE = "2020-02-01T00:00:00Z";
const runStartedAt = DateTime.makeUnsafe("2020-02-01T00:00:00.999Z");
const processLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const storeLayer = CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer));
const testLayer = CheckpointService.layer.pipe(
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(processLayer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "checkpoint-attribution-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const git = Effect.fnUntraced(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  date = OLD_DATE,
) {
  const process = yield* VcsProcess.VcsProcess;
  const result = yield* process.run({
    operation: "CheckpointGitAttribution.test.git",
    command: "git",
    cwd,
    args,
    env: { ...globalThis.process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    outputMode: "error",
  });
  return result.stdout.trim();
});

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-attribution-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["config", "user.email", "test@example.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  const write = (file: string, contents: string) =>
    fs.writeFileString(NodePath.join(cwd, file), contents);
  yield* write("shared.txt", "original\n");
  yield* write("dirty.txt", "clean\n");
  yield* write("conflict.txt", "base\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "base"]);
  const originalHead = yield* git(cwd, ["rev-parse", "HEAD"]);
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("scope:git-attribution"),
    threadId: ThreadId.make("thread:git-attribution"),
    runId: RunId.make("run:git-attribution"),
    nodeId: NodeId.make("node:git-attribution"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:git-attribution"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd,
    createdAt: runStartedAt,
  };
  const service = yield* CheckpointService.CheckpointServiceV2;
  const baseline = (ordinalWithinScope = 0) =>
    service.captureBaseline({ scope, ordinalWithinScope });
  const capture = (ordinalWithinScope = 1) =>
    service.capture({
      scope,
      runId: scope.runId,
      nodeId: scope.nodeId!,
      ordinalWithinScope,
      appRunOrdinal: ordinalWithinScope,
      capturedAt: DateTime.makeUnsafe("2020-02-01T00:01:00Z"),
      runStartedAt,
    });
  const importedBranch = Effect.gen(function* () {
    yield* git(cwd, ["checkout", "-b", "feature"]);
    yield* write("shared.txt", "imported\nmore\n");
    yield* git(cwd, ["commit", "-am", "upstream"]);
    yield* git(cwd, ["checkout", "main"]);
  });
  return { cwd, scope, write, baseline, capture, importedBranch, originalHead };
});

it.layer(testLayer)("checkpoint Git attribution", (it) => {
  it.effect("keeps the full diff on the unchanged-HEAD fast path", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.baseline();
      yield* repo.write("dirty.txt", "agent\n");
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(checkpoint.gitUpdate).toBeUndefined();
      const message = yield* git(repo.cwd, ["show", "-s", "--format=%B", checkpoint.ref]);
      expect(message).toContain(`head=${repo.originalHead} branch=refs/heads/main`);
    }),
  );

  it.effect("groups checkout changes and persists only the aggregate", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* git(repo.cwd, ["checkout", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files).toEqual([]);
      expect(checkpoint.gitUpdate).toEqual({
        fromHead: repo.originalHead,
        toHead: yield* git(repo.cwd, ["rev-parse", "HEAD"]),
        fromBranch: "refs/heads/main",
        toBranch: "refs/heads/feature",
        fileCount: 1,
        additions: 2,
        deletions: 1,
      });
    }),
  );

  it.effect("groups a fast-forward pull", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* git(repo.cwd, ["pull", "--ff-only", ".", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files).toEqual([]);
      expect(checkpoint.gitUpdate).toMatchObject({
        fromBranch: "refs/heads/main",
        toBranch: "refs/heads/main",
        fileCount: 1,
      });
    }),
  );

  it.effect("attributes a fresh agent commit at the rounded-down run boundary", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* git(repo.cwd, ["checkout", "feature"]);
      yield* repo.write("dirty.txt", "agent\n");
      yield* git(repo.cwd, ["commit", "-am", "agent"], RUN_DATE);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(checkpoint.gitUpdate?.fileCount).toBe(1);
    }),
  );

  it.effect("keeps amended changes as agent work", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* git(repo.cwd, ["checkout", "feature"]);
      yield* repo.write("dirty.txt", "amended\n");
      yield* git(repo.cwd, ["commit", "-am", "amended", "--amend"], RUN_DATE);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt", "shared.txt"]);
      expect(checkpoint.gitUpdate).toBeUndefined();
    }),
  );

  it.effect("keeps rebased commits while grouping imported upstream files", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* repo.write("dirty.txt", "rebased work\n");
      yield* git(repo.cwd, ["commit", "-am", "old local work"]);
      yield* git(repo.cwd, ["rebase", "feature"], RUN_DATE);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(checkpoint.gitUpdate?.fileCount).toBe(1);
    }),
  );

  it.effect("counts only the combined merge resolution as agent work", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* git(repo.cwd, ["checkout", "feature"]);
      yield* repo.write("conflict.txt", "theirs\n");
      yield* git(repo.cwd, ["commit", "-am", "theirs"]);
      yield* git(repo.cwd, ["checkout", "main"]);
      yield* repo.write("conflict.txt", "ours\n");
      yield* git(repo.cwd, ["commit", "-am", "ours"]);
      yield* repo.baseline();
      const mergeError = yield* git(
        repo.cwd,
        ["merge", "feature", "--no-edit", "--no-ff"],
        RUN_DATE,
      ).pipe(Effect.flip);
      expect(mergeError).toMatchObject({ exitCode: 1 });
      expect(yield* git(repo.cwd, ["show", ":shared.txt"])).toBe("imported\nmore");
      yield* repo.write("conflict.txt", "resolved\n");
      yield* git(repo.cwd, ["add", "conflict.txt"]);
      yield* git(repo.cwd, ["commit", "-m", "resolve"], RUN_DATE);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["conflict.txt"]);
      expect(checkpoint.gitUpdate?.fileCount).toBe(1);
    }),
  );

  it.effect("keeps a dirty edit carried across checkout", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* repo.write("dirty.txt", "dirty edit\n");
      yield* git(repo.cwd, ["checkout", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(checkpoint.gitUpdate?.fileCount).toBe(1);
    }),
  );

  it.effect("keeps dirty work discarded by reset --hard", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.write("shared.txt", "uncommitted baseline\n");
      yield* repo.baseline();
      yield* git(repo.cwd, ["reset", "--hard", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["shared.txt"]);
      expect(checkpoint.gitUpdate).toBeUndefined();
    }),
  );

  it.effect("keeps legacy checkpoints on the full-diff path", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      const ref = CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: repo.scope.id,
        ordinalWithinScope: 0,
      });
      const tree = yield* git(repo.cwd, ["rev-parse", `${ref}^{tree}`]);
      const legacy = yield* git(repo.cwd, [
        "commit-tree",
        tree,
        "-m",
        `supacode checkpoint ref=${ref}`,
      ]);
      yield* git(repo.cwd, ["update-ref", ref, legacy]);
      yield* git(repo.cwd, ["checkout", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["shared.txt"]);
      expect(checkpoint.gitUpdate).toBeUndefined();
    }),
  );

  it.effect("groups HEAD moved while idle when captureBaseline reuses the previous turn", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      const first = yield* repo.capture();
      const previousOid = yield* git(repo.cwd, ["rev-parse", first.ref]);
      yield* git(repo.cwd, ["pull", "--ff-only", ".", "feature"]);
      yield* repo.baseline(1);
      expect(yield* git(repo.cwd, ["rev-parse", first.ref])).toBe(previousOid);
      yield* repo.write("dirty.txt", "next turn\n");
      const checkpoint = yield* repo.capture(2);
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(checkpoint.gitUpdate?.fileCount).toBe(1);
    }),
  );

  it.effect("omits HEAD metadata for an unborn branch and preserves its changes", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* git(repo.cwd, ["checkout", "--orphan", "unborn"]);
      yield* git(repo.cwd, ["rm", "-rf", "."]);
      yield* repo.write("first.txt", "first\n");
      yield* repo.baseline();
      const ref = CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: repo.scope.id,
        ordinalWithinScope: 0,
      });
      expect(yield* git(repo.cwd, ["show", "-s", "--format=%B", ref])).not.toContain("head=");
      yield* git(repo.cwd, ["add", "."]);
      yield* git(repo.cwd, ["commit", "-m", "first"], RUN_DATE);
      yield* repo.write("first.txt", "after first commit\n");
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["first.txt"]);
      expect(checkpoint.gitUpdate).toBeUndefined();
    }),
  );

  it.effect("groups binary changes and both rename paths with literal filenames", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.write("binary.bin", "\0before");
      yield* git(repo.cwd, ["add", "."]);
      yield* git(repo.cwd, ["commit", "-m", "binary"]);
      yield* git(repo.cwd, ["checkout", "-b", "feature"]);
      yield* git(repo.cwd, ["mv", "shared.txt", "renamed 名.txt"]);
      yield* repo.write("binary.bin", "\0after");
      yield* git(repo.cwd, ["commit", "-am", "upstream rename"]);
      yield* git(repo.cwd, ["checkout", "main"]);
      yield* repo.baseline();
      yield* git(repo.cwd, ["checkout", "feature"]);
      yield* repo.write("dirty.txt", "agent\n");
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(checkpoint.gitUpdate).toMatchObject({ fileCount: 3, additions: 1, deletions: 1 });
    }),
  );

  it.effect("records detached HEAD without a branch", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      yield* git(repo.cwd, ["checkout", "--detach", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files).toEqual([]);
      expect(checkpoint.gitUpdate?.toBranch).toBeNull();
      expect(yield* git(repo.cwd, ["show", "-s", "--format=%B", checkpoint.ref])).not.toContain(
        "branch=",
      );
    }),
  );

  it.effect("fails open when a stored HEAD commit is unavailable", () =>
    Effect.gen(function* () {
      const repo = yield* setup();
      yield* repo.importedBranch;
      yield* repo.baseline();
      const ref = CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: repo.scope.id,
        ordinalWithinScope: 0,
      });
      const tree = yield* git(repo.cwd, ["rev-parse", `${ref}^{tree}`]);
      const unavailable = yield* git(repo.cwd, [
        "commit-tree",
        tree,
        "-m",
        `supacode checkpoint ref=${ref} head=${"a".repeat(40)} branch=refs/heads/main`,
      ]);
      yield* git(repo.cwd, ["update-ref", ref, unavailable]);
      yield* git(repo.cwd, ["checkout", "feature"]);
      const checkpoint = yield* repo.capture();
      expect(checkpoint.files.map((file) => file.path)).toEqual(["shared.txt"]);
      expect(checkpoint.gitUpdate).toBeUndefined();
    }),
  );
});
