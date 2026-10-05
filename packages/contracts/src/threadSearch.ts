import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnItemId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Literal, case-insensitive occurrences in the current thread's visible history. */
export const OrchestrationSearchThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
  query: TrimmedString.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadMessagesInput =
  typeof OrchestrationSearchThreadMessagesInput.Type;

export const OrchestrationThreadMessageSearchMatch = Schema.Struct({
  index: NonNegativeInt,
  threadId: ThreadId,
  itemId: TurnItemId,
  // UTF-16 offsets into the item's text (or a proposed plan's Markdown).
  start: NonNegativeInt,
  end: NonNegativeInt,
  snippetStart: NonNegativeInt,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
});
export type OrchestrationThreadMessageSearchMatch =
  typeof OrchestrationThreadMessageSearchMatch.Type;

export const OrchestrationSearchThreadMessagesResult = Schema.Struct({
  totalMatches: NonNegativeInt,
  matches: Schema.Array(OrchestrationThreadMessageSearchMatch).check(Schema.isMaxLength(50)),
});
export type OrchestrationSearchThreadMessagesResult =
  typeof OrchestrationSearchThreadMessagesResult.Type;

export class OrchestrationSearchThreadMessagesError extends Schema.TaggedError<OrchestrationSearchThreadMessagesError>()(
  "OrchestrationSearchThreadMessagesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
