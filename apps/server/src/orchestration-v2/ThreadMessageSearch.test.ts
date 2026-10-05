import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { buildBoundedThreadProjection } from "./threadHistoryPaging.ts";
import { THREAD_MESSAGE_SEARCH_CHUNK_LENGTH } from "./threadMessageSearch.ts";

const databaseLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");

const putThread = Effect.fnUntraced(function* (
  threadId: ThreadId,
  forkedFrom: OrchestrationV2AppThread["forkedFrom"] = null,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`thread:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("project:thread-find"),
      title: "Thread find",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const putRun = Effect.fnUntraced(function* (
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  status: OrchestrationV2Run["status"] = "completed",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`run:${runId}:${status}`),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: NodeId.make(`root:${runId}`),
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
});

const itemBase = (threadId: ThreadId, id: string, ordinal: number, runId: RunId | null = null) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: runId === null ? null : NodeId.make(`root:${runId}`),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const putMessage = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly ordinal: number;
  readonly text: string;
  readonly role?: "user" | "assistant";
  readonly runId?: RunId;
  readonly queued?: boolean;
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const base = itemBase(input.threadId, input.id, input.ordinal, input.runId ?? null);
  yield* store.apply({
    id: EventId.make(`item:${input.id}`),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: now,
    payload:
      input.role === "assistant"
        ? {
            ...base,
            type: "assistant_message",
            messageId: MessageId.make(`message:${input.id}`),
            text: input.text,
            streaming: false,
          }
        : {
            ...base,
            type: "user_message",
            messageId: MessageId.make(`message:${input.id}`),
            text: input.text,
            attachments: [],
            inputIntent: input.queued ? "queued_turn" : "turn_start",
            createdBy: "user",
            creationSource: "web",
          },
  });
});

for (const storage of ["sqlite", "memory"] as const) {
  const testLayer = storage === "sqlite" ? databaseLayer : ProjectionStore.layerMemory;
  it.layer(testLayer)(`ThreadMessageSearch (${storage})`, (it) => {
    it.effect("finds old history and pages individual occurrences in chronological order", () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:find-old");
        yield* putThread(threadId);
        const text = "🔎 NEEDLE needle\n**needle**";
        yield* putMessage({ threadId, id: "old", ordinal: 1, text });
        for (let index = 0; index < 350; index += 1)
          yield* putMessage({
            threadId,
            id: `filler:${index}`,
            ordinal: index + 2,
            text: "filler",
          });
        yield* putMessage({ threadId, id: "new", ordinal: 352, text: "needle", role: "assistant" });
        yield* store.apply({
          id: EventId.make("plan"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...itemBase(threadId, "plan", 353),
            type: "proposed_plan",
            planId: PlanId.make("plan"),
            markdown: "# needle plan",
            streaming: false,
          },
        });
        const recent = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 10 });
        assert.notInclude(
          recent.projection.visibleTurnItems.map((row) => row.sourceItemId),
          TurnItemId.make("old"),
        );
        const result = yield* store.searchThreadMessages({ threadId, query: "needle", limit: 2 });
        assert.equal(result.totalMatches, 5);
        assert.deepEqual(
          result.matches.map((match) => [match.index, match.itemId, match.start, match.end]),
          [
            [0, "old", 3, 9],
            [1, "old", 10, 16],
          ],
        );
        const page = yield* store.searchThreadMessages({
          threadId,
          query: "NEEDLE",
          offset: 2,
          limit: 2,
        });
        assert.deepEqual(
          page.matches.map((match) => [match.index, match.itemId]),
          [
            [2, "old"],
            [3, "new"],
          ],
        );
        const last = yield* store.searchThreadMessages({ threadId, query: "needle", offset: 4 });
        assert.deepEqual(
          last.matches.map((match) => match.itemId),
          ["plan"],
        );
        assert.deepEqual(
          (yield* store.searchThreadMessages({ threadId, query: "needle", offset: 5 })).matches,
          [],
        );
        assert.equal(
          (yield* store.searchThreadMessages({ threadId, query: "absent" })).totalMatches,
          0,
        );
      }),
    );

    it.effect(
      "matches literal syntax and Unicode across large text chunks with exact excerpts",
      () =>
        Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make("thread:find-large");
          yield* putThread(threadId);
          const query = "a.*[b]";
          const prefix = "😀".repeat(8) + "x".repeat(THREAD_MESSAGE_SEARCH_CHUNK_LENGTH - 34);
          const text = prefix + query + "y".repeat(THREAD_MESSAGE_SEARCH_CHUNK_LENGTH + 17) + query;
          yield* putMessage({ threadId, id: "large", ordinal: 1, text });
          const result = yield* store.searchThreadMessages({ threadId, query });
          assert.equal(result.totalMatches, 2);
          assert.deepEqual(
            result.matches.map((match) => match.start),
            [prefix.length, text.lastIndexOf(query)],
          );
          for (const match of result.matches) {
            assert.isAtMost(match.snippet.length, 240);
            assert.equal(
              match.snippet,
              text.slice(match.snippetStart, match.snippetStart + match.snippet.length),
            );
            assert.equal(
              match.snippet.slice(match.start - match.snippetStart, match.end - match.snippetStart),
              query,
            );
          }
          const longQuery = "a".repeat(200);
          const longText = "b".repeat(300) + longQuery + "c".repeat(300);
          yield* putMessage({ threadId, id: "long-query", ordinal: 2, text: longText });
          const longResult = yield* store.searchThreadMessages({ threadId, query: longQuery });
          assert.equal(longResult.totalMatches, 1);
          const longMatch = longResult.matches[0]!;
          assert.equal(
            longMatch.snippet.slice(
              longMatch.start - longMatch.snippetStart,
              longMatch.end - longMatch.snippetStart,
            ),
            longQuery,
          );
          yield* putMessage({ threadId, id: "unicode", ordinal: 3, text: "😀 KELVIN kelvin" });
          const splitEmoji = "x".repeat(THREAD_MESSAGE_SEARCH_CHUNK_LENGTH - 2);
          const nulText = splitEmoji + "😀needle\0needle";
          yield* putMessage({ threadId, id: "nul", ordinal: 4, text: nulText });
          const nulResult = yield* store.searchThreadMessages({ threadId, query: "needle" });
          assert.deepEqual(
            nulResult.matches.map((match) => match.start),
            [splitEmoji.length + 2, splitEmoji.length + 9],
          );
          assert.deepEqual(
            (yield* store.searchThreadMessages({ threadId, query: "kelvin" })).matches.map(
              (match) => [match.start, match.end],
            ),
            [
              [3, 9],
              [10, 16],
            ],
          );
        }),
    );

    it.effect(
      "searches inherited fork history and follows canonical rollback and attempt visibility",
      () =>
        Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const source = ThreadId.make("thread:find-source");
          const target = ThreadId.make("thread:find-target");
          const run1 = RunId.make("run:find:1");
          const run2 = RunId.make("run:find:2");
          const cancelled = RunId.make("run:find:cancelled");
          yield* putThread(source);
          yield* putRun(source, run1, 1);
          yield* putRun(source, run2, 2);
          yield* putMessage({
            threadId: source,
            id: "inherited",
            ordinal: 1,
            runId: run1,
            text: "needle ancestor" + "x".repeat(5_000),
          });
          yield* putMessage({
            threadId: source,
            id: "after-fork",
            ordinal: 2,
            runId: run2,
            text: "needle after fork",
          });
          yield* putThread(target, { type: "run", threadId: source, runId: run1 });
          yield* putRun(target, cancelled, 1, "cancelled");
          yield* putMessage({
            threadId: target,
            id: "cancelled",
            ordinal: 1,
            runId: cancelled,
            queued: true,
            text: "needle cancelled queue",
          });
          yield* putMessage({ threadId: target, id: "local", ordinal: 2, text: "needle local" });
          yield* putRun(source, run1, 1, "rolled_back");
          assert.deepEqual(
            (yield* store.searchThreadMessages({ threadId: source, query: "needle" })).matches.map(
              (match) => match.itemId,
            ),
            ["after-fork"],
          );
          const forkMatches = yield* store.searchThreadMessages({
            threadId: target,
            query: "needle",
          });
          assert.deepEqual(
            forkMatches.matches.map((match) => [match.threadId, match.itemId]),
            [
              [source, "inherited"],
              [target, "local"],
            ],
          );

          const anchored = yield* store.getThreadSnapshotWindow(target, {
            rowLimit: 10,
            anchorItemId: TurnItemId.make("inherited"),
            anchorThreadId: source,
          });
          const bounded = buildBoundedThreadProjection({
            projection: anchored.projection,
            snapshotSequence: anchored.snapshotSequence,
            anchorItemId: TurnItemId.make("inherited"),
            anchorThreadId: source,
            policy: { maxItems: 10, maxEncodedBytes: 1_000 },
          });
          assert.deepEqual(
            bounded.projection.visibleTurnItems.map((row) => row.sourceItemId),
            ["inherited"],
          );

          const superseded = RunId.make("run:find:superseded");
          yield* putRun(target, superseded, 2);
          yield* store.apply({
            id: EventId.make("superseded-attempt"),
            type: "run-attempt.created",
            threadId: target,
            runId: superseded,
            occurredAt: now,
            payload: {
              id: RunAttemptId.make("attempt:find:superseded"),
              runId: superseded,
              attemptOrdinal: 1,
              rootNodeId: NodeId.make(`root:${superseded}`),
              providerInstanceId,
              providerThreadId: ProviderThreadId.make("provider-thread:find"),
              providerTurnId: null,
              reason: "initial",
              status: "superseded",
              startedAt: now,
              completedAt: now,
            },
          });
          yield* putMessage({
            threadId: target,
            id: "superseded-answer",
            ordinal: 3,
            runId: superseded,
            role: "assistant",
            text: "needle visible earlier answer",
          });
          // Earlier assistant output remains visible when an attempt is superseded.
          assert.include(
            (yield* store.searchThreadMessages({ threadId: target, query: "needle" })).matches.map(
              (match) => match.itemId,
            ),
            TurnItemId.make("superseded-answer"),
          );
          assert.instanceOf(
            yield* Effect.flip(
              store.searchThreadMessages({ threadId: ThreadId.make("missing"), query: "needle" }),
            ),
            ProjectionStore.ProjectionStoreThreadNotFoundError,
          );
        }),
    );
  });
}

it.effect("does not decode unrelated tool output or return more than the bounded match page", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:find-bounded");
    yield* putThread(threadId);
    yield* putMessage({ threadId, id: "many", ordinal: 1, text: "needle ".repeat(5_000) });
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
      type, status, ordinal, updated_at, payload_json
    ) VALUES ('corrupt-tool', ${threadId}, NULL, NULL, NULL, NULL,
      'tool_call', 'completed', 2, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
    const result = yield* store.searchThreadMessages({ threadId, query: "needle", offset: 4_900 });
    assert.equal(result.totalMatches, 5_000);
    assert.lengthOf(result.matches, 50);
    assert.equal(result.matches[0]?.index, 4_900);
    assert.equal(result.matches[49]?.index, 4_949);
    yield* sql`UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.text', 20261005)
      WHERE turn_item_id = 'many'`;
    assert.instanceOf(
      yield* Effect.flip(store.searchThreadMessages({ threadId, query: "needle" })),
      ProjectionStore.ProjectionStoreReadError,
    );
  }).pipe(Effect.provide(databaseLayer)),
);
