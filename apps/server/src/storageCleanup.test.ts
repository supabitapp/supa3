import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@supacode/shared/nodeSqliteClient";
import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it.each(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "allows cleanup once its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(true);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
    defaultRepositoryKey: "github.com/owner/repo",
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    repositoryKey: "github.com/owner/repo",
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
    ["was merged into a different repository", { repositoryKey: "github.com/upstream/repo" }],
    ["has no verified target repository", { repositoryKey: null }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });

  it("retains a squash worktree when the cleanup remote cannot be identified", () => {
    expect(
      storageCleanupPullRequestMerged(pullRequest(), { ...squashed, defaultRepositoryKey: null }),
    ).toBe(false);
  });
});

it.each([
  ...["pending", "running", "failed", "succeeded", "cancelled"].map((status) => ({
    status,
    mergeOnly: false,
    repositoryKey: "github.com/owner/repo",
    removes: status === "succeeded" || status === "cancelled",
  })),
  { status: "succeeded", mergeOnly: true, repositoryKey: "github.com/owner/repo", removes: true },
  { status: "succeeded", mergeOnly: true, repositoryKey: "github.com/other/repo", removes: false },
])(
  "checks completed worktree cleanup, effect=$status merge=$mergeOnly target=$repositoryKey",
  async ({ status, mergeOnly, repositoryKey, removes }) => {
    const layer = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "supacode-cleanup-effects-" }),
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const worktreePath = path.join(config.worktreesDir, "fixture");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "test registration");
      const candidate = shell({ worktreePath, branch: "retained", status: "completed" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, effect_type TEXT, status TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES (${candidate.id}, 'checkpoint.capture', ${status})`;
      const scanned = yield* Deferred.make<void>();
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: mergeOnly ? null : 1,
          worktreeOnMerge: mergeOnly,
        },
      };
      let removals = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
          subscribeChanges: Effect.succeed(Stream.empty),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () =>
            Effect.succeed([{ id: candidate.projectId, workspaceRoot: process.cwd() }] as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: (options) =>
            Effect.succeed({
              threads: options?.location === "archive" ? [] : [candidate],
            } as never),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: () => Effect.succeed(() => {}),
        }),
        Layer.mock(GitManager.GitManager)({
          invalidateStatus: () => Effect.void,
          branchPullRequest: () =>
            Effect.succeed({
              state: "merged",
              headRef: "retained",
              baseRef: "main",
              headSha: "a".repeat(40),
              repositoryKey,
            } as never),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetailsLocal: () =>
            Deferred.succeed(scanned, undefined).pipe(
              Effect.as({
                isRepo: true,
                branch: "retained",
                hasWorkingTreeChanges: false,
              } as never),
            ),
          resolveCommit: ({ revision }) =>
            Effect.succeed({ commitSha: (revision === "HEAD" ? "a" : "b").repeat(40) }),
          resolvePrimaryRemoteName: () => Effect.succeed("published"),
          resolveDefaultBranchName: () => Effect.succeed("main"),
          fetchRemoteTrackingBranch: () => Effect.void,
          readConfigValue: (_cwd, key) =>
            Effect.sync(() => {
              expect(key).toBe("remote.published.url");
              return "git@github.com:owner/repo.git";
            }),
          execute: (input) =>
            Effect.succeed({
              stdout: "",
              stdoutTruncated: false,
              exitCode: input.operation === "StorageCleanup.integratedBranch" ? 1 : 0,
            } as never),
          removeWorktree: () =>
            Effect.sync(() => {
              removals++;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* StorageCleanup.make;
        yield* service.start();
        yield* Deferred.await(scanned);
        yield* service.drain;
      }).pipe(Effect.provide(dependencies));
      expect(removals).toBe(removes ? 1 : 0);
      expect(yield* fs.exists(worktreePath)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  },
);
