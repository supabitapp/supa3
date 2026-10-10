import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
  type OrchestrationV2ThreadShell,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FeedbackService from "./FeedbackService.ts";
import { TRIAGE_PLAYBOOK } from "./triagePrompt.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("configured-provider"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: [
    { slug: "configured-model", name: "Configured model", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const input = {
  commandId: CommandId.make("feedback-command"),
  threadId: ThreadId.make("feedback-thread"),
};

const withFeedback = <A, E>(
  options: { readonly providers?: readonly ServerProvider[]; readonly preferred?: ModelSelection },
  body: (harness: {
    readonly launches: ThreadLaunch.ThreadLaunchInput[];
    readonly scratchRequests: { count: number; folderClaims: number };
    readonly directory: string;
  }) => Effect.Effect<
    A,
    E,
    | FeedbackService.FeedbackService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const launches: ThreadLaunch.ThreadLaunchInput[] = [];
      const scratchRequests = { count: 0, folderClaims: 0 };
      const receipts = new Map<CommandId, CommandReceiptStore.CommandReceiptV2>();
      const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "supacode-feedback-" });
      const directory = path.join(baseDir, "scratch", "feedback-thread");
      const layer = FeedbackService.layer.pipe(
        Layer.provide(
          Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
            getByCommandId: (commandId) =>
              Effect.sync(() => Option.fromNullishOr(receipts.get(commandId))),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
          }),
        ),
        Layer.provideMerge(ServerConfig.layerTest("/environment", baseDir)),
        Layer.provide(ProviderRegistryMock.layer(options.providers ?? [provider])),
        Layer.provide(
          ServerSettings.layerTest({ defaultModelSelection: options.preferred ?? null }),
        ),
        Layer.provide(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            folderForThread: () =>
              Effect.sync(() => {
                scratchRequests.folderClaims++;
                return Option.some(directory);
              }),
            ensureScratchProject: Effect.sync(() => {
              scratchRequests.count++;
              return { projectId: ProjectId.make("scratch-project") };
            }),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: (launch) =>
              Effect.sync(() => {
                launches.push(launch);
                receipts.set(launch.commandId, {
                  commandId: launch.commandId,
                  threadId: launch.threadId!,
                  commandType: "thread.create",
                  acceptedAt: DateTime.makeUnsafe("2026-10-10T00:00:00.000Z"),
                  resultSequence: 1,
                  status: "accepted",
                  error: null,
                });
                shells.set(launch.threadId!, {
                  projectId: launch.projectId,
                  worktreePath: directory,
                } as OrchestrationV2ThreadShell);
                return { threadId: launch.threadId! } as ThreadLaunch.ThreadLaunchResult;
              }),
          }),
        ),
      );
      return yield* body({ launches, scratchRequests, directory }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

it.effect(
  "starts a supervised scratch thread with the existing guide and this environment's paths",
  () =>
    withFeedback({}, ({ launches, directory }) =>
      Effect.gen(function* () {
        const feedback = yield* FeedbackService.FeedbackService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(
          yield* feedback.start(input, { surface: "mobile", clientAppVersion: "1.2.3" }),
          {
            threadId: input.threadId,
          },
        );
        const launch = launches[0]!;
        assert.equal(launch.projectId, "scratch-project");
        assert.equal(launch.workspaceStrategy.type, "existing_worktree");
        assert.equal(launch.runtimeMode, "approval-required");
        assert.equal(launch.creationSource, "mobile");
        const prompt = yield* fs.readFileString(path.join(directory, "feedback-guide.md"));
        assert.equal(launch.initialMessage!.context!.instructions, prompt);
        assert.lengthOf(launch.initialMessage!.context!.records, 0);
        assert.include(prompt, TRIAGE_PLAYBOOK);
        assert.include(prompt, "Send feedback");
        const context = yield* fs.readFileString(path.join(directory, "feedback-context.md"));
        assert.deepEqual(launch.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: directory,
        });
        assert.include(context, config.dbPath);
        assert.include(context, config.serverTracePath);
        assert.include(context, "NEVER read this");
        assert.include(context, "clientAppVersion: 1.2.3");
        assert.notInclude(launch.initialMessage!.text, config.stateDir);
      }),
    ),
);

it.effect(
  "uses the configured model and its options, with an explicit selection taking priority",
  () => {
    const preferred = {
      instanceId: provider.instanceId,
      model: "custom-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    return withFeedback({ preferred }, ({ launches }) =>
      Effect.gen(function* () {
        const feedback = yield* FeedbackService.FeedbackService;
        yield* feedback.start(input);
        assert.deepEqual(launches[0]!.modelSelection, preferred);
        const explicit = { ...preferred, model: "current-thread-model" };
        yield* feedback.start({
          ...input,
          commandId: CommandId.make("other-command"),
          threadId: ThreadId.make("other-thread"),
          modelSelection: explicit,
        });
        assert.deepEqual(launches[1]!.modelSelection, explicit);
      }),
    );
  },
);

it.effect("falls back to an available provider when the configured one is unavailable", () =>
  withFeedback(
    { preferred: { instanceId: ProviderInstanceId.make("missing"), model: "missing-model" } },
    ({ launches }) =>
      Effect.gen(function* () {
        yield* (yield* FeedbackService.FeedbackService).start(input);
        assert.deepEqual(launches[0]!.modelSelection, {
          instanceId: provider.instanceId,
          model: "configured-model",
        });
      }),
  ),
);

it.effect("does not create a thread or diagnostics when no provider is available", () =>
  withFeedback(
    { providers: [{ ...provider, installed: false }] },
    ({ launches, scratchRequests }) =>
      Effect.gen(function* () {
        const feedback = yield* FeedbackService.FeedbackService;
        const error = yield* feedback.start(input).pipe(Effect.flip);
        assert.equal(error.stage, "choose-provider");
        assert.equal(scratchRequests.count, 0);
        assert.lengthOf(launches, 0);
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        assert.isFalse(
          yield* (yield* FileSystem.FileSystem).exists(path.join(config.baseDir, "scratch")),
        );
      }),
  ),
);

it.effect("keeps retry messages stable and uses the server-owned scratch folder", () =>
  withFeedback({}, ({ launches, scratchRequests, directory }) =>
    Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      const retry = { ...input, threadId: ThreadId.make("../../outside") };
      yield* Effect.all([feedback.start(retry), feedback.start(retry)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(launches[0], launches[1]);
      assert.equal(scratchRequests.folderClaims, 1);
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      assert.isTrue(directory.startsWith(path.join(config.baseDir, "scratch")));
      assert.include(
        launches[0]!.initialMessage!.context!.instructions!,
        path.join(directory, "feedback-context.md"),
      );
    }),
  ),
);

it.effect("rejects a replay that names a different thread", () =>
  withFeedback({}, ({ launches }) =>
    Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      yield* feedback.start(input);
      const failure = yield* feedback
        .start({ ...input, threadId: ThreadId.make("different-thread") })
        .pipe(Effect.flip);
      assert.equal(failure.stage, "launch-thread");
      assert.lengthOf(launches, 1);
    }),
  ),
);

it.effect("does not start the provider when preparing the guide fails", () =>
  withFeedback({}, ({ launches, directory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
      yield* fs.writeFileString(directory, "occupied");
      const failure = yield* (yield* FeedbackService.FeedbackService)
        .start(input)
        .pipe(Effect.flip);
      assert.equal(failure.stage, "prepare-context");
      assert.lengthOf(launches, 0);
    }),
  ),
);
