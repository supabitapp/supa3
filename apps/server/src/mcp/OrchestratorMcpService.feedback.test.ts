import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

it.effect("recovers feedback instructions through paginated MCP history", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:feedback-history");
    const shell = liveThreadShell(threadId, { activeRunId: null });
    const now = DateTime.makeUnsafe("2026-10-10T00:00:00Z");
    const instructions = "Read /feedback/feedback-context.md. Review the report before submitting.";
    const item = {
      id: TurnItemId.make("item:feedback-history"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_message",
      text: "I'd like to send feedback about Supacode.",
      context: { version: 1, records: [], instructions },
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message:feedback-history"),
      inputIntent: "turn_start",
    } satisfies OrchestrationV2TurnItem;
    const projection = OrchestrationV2ThreadProjection.make({
      thread: { ...shell, lastVisitedAt: null },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [item],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        },
      ],
      updatedAt: now,
    });
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getThreadRecords: () => Effect.succeed(projection),
            getProjectThreadRecords: () => Effect.succeed(projection),
            getTimelinePage: () =>
              Effect.succeed({ items: projection.visibleTurnItems, totalItems: 1, hasMore: false }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const scope = {
        environmentId: EnvironmentId.make("environment:feedback-history"),
        requestNamespace: "provider-session:feedback-history",
        thread: {
          threadId,
          providerSessionId: "provider-session:feedback-history",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      } satisfies McpInvocationScope;
      const first = yield* service.readThread(scope, {
        threadId,
        maxCharsPerItem: item.text.length,
      });
      assert.equal(first.items[0]?.text, item.text);
      assert.isTrue(first.items[0]?.textTruncated);
      const rest = yield* service.readThread(scope, {
        threadId,
        itemId: item.id,
        textOffset: first.items[0]!.nextTextOffset!,
      });
      assert.equal(rest.items[0]?.text, `\n\n${instructions}`);
      assert.isFalse(rest.items[0]?.textTruncated);
    }).pipe(Effect.provide(layer));
  }),
);
