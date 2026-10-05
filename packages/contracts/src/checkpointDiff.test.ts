import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  ThreadTurnDiff,
} from "./checkpointDiff.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes the Git changes opt-in on turn and full-thread queries", () =>
  Effect.gen(function* () {
    const input = {
      threadId: "thread-1",
      fromTurnCount: 0,
      toTurnCount: 1,
      includeGitChanges: true,
    };
    assert.isTrue((yield* decodeTurnDiffInput(input)).includeGitChanges);
    assert.isTrue((yield* decodeFullThreadDiffInput(input)).includeGitChanges);
    assert.isUndefined(
      (yield* decodeTurnDiffInput({ threadId: "thread-1", fromTurnCount: 0, toTurnCount: 1 }))
        .includeGitChanges,
    );
  }),
);
