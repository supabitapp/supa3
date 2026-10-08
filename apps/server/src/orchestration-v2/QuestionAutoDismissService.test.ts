import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as QuestionAutoDismissService from "./QuestionAutoDismissService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "question-auto-dismiss" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const seedRequest = Effect.fnUntraced(function* (
  name: string,
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
  archived = false,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${name}`);
  const requestId = RuntimeRequestId.make(`request:${name}`);
  const sessionId = ProviderSessionId.make(`session:${name}`);
  const instanceId = ProviderInstanceId.make("codex");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make("project:questions"),
    title: name,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* projections.apply({
    id: EventId.make(`session:${name}`),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/repo",
      model: "gpt-5.4",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`request:${name}`),
    type: "runtime-request.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: requestId,
      nodeId: NodeId.make(`node:${name}`),
      providerTurnId: null,
      nativeRequestRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: name,
        strength: "strong",
      },
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: sessionId },
      createdAt: DateTime.subtract(now, { minutes: 2 }),
      resolvedAt: null,
      ...overrides,
    },
  });
  if (archived) {
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`archive:${name}`),
      threadId,
    });
  }
  return { threadId, requestId };
});

it.effect.each([false, true])("only dismisses expired questions when enabled: %s", (enabled) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const codex = yield* seedRequest("codex");
    const claude = yield* seedRequest("claude", {
      nativeRequestRef: {
        driver: ProviderDriverKind.make("claude"),
        nativeId: "claude",
        strength: "strong",
      },
    });
    const asyncQuestion = yield* seedRequest("async", { responseCapability: { type: "message" } });
    const waiting = [
      yield* seedRequest("new", { createdAt: DateTime.subtract(now, { seconds: 119 }) }),
      yield* seedRequest("approval", { kind: "command" }),
      yield* seedRequest("resolved", { status: "resolved", resolvedAt: now }),
      yield* seedRequest("offline", {
        responseCapability: { type: "not_resumable", reason: "Offline" },
      }),
      yield* seedRequest("other-provider", {
        nativeRequestRef: {
          driver: ProviderDriverKind.make("opencode"),
          nativeId: "other",
          strength: "strong",
        },
      }),
      yield* seedRequest("archived", {}, true),
    ];

    yield* Effect.gen(function* () {
      const questions = yield* QuestionAutoDismissService.QuestionAutoDismissService;
      yield* questions.sweep;
      yield* questions.sweep;
    }).pipe(
      Effect.provide(
        QuestionAutoDismissService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  autoDismissQuestions: enabled,
                }),
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                dispatch: orchestrator.dispatch,
              }),
            ),
          ),
        ),
      ),
    );

    for (const target of [codex, claude, asyncQuestion]) {
      const request = yield* projections.getRuntimeRequest(target.threadId, target.requestId);
      assert.equal(request?.status, enabled ? "resolved" : "pending");
      assert.equal(request?.decision, enabled ? "cancel" : undefined);
      assert.deepEqual(request?.answers, enabled && target !== asyncQuestion ? {} : undefined);
      assert.lengthOf((yield* orchestrator.getThreadProjection(target.threadId)).messages, 0);
    }
    for (const target of waiting) {
      const request = yield* projections.getRuntimeRequest(target.threadId, target.requestId);
      assert.isUndefined(request?.decision);
    }
  }).pipe(Effect.provide(layerTest)),
);
