import { RunId } from "@supacode/contracts";
import type {
  OrchestrationThreadMessageSearchMatch,
  OrchestrationV2ThreadProjection,
  ThreadId,
  TurnItemId,
} from "@supacode/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

export type ThreadFindTarget = {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly navigationKey: string;
  readonly projection: OrchestrationV2ThreadProjection;
};

export function isThreadFindTarget(
  entry: ThreadFeedEntry,
  target: Pick<ThreadFindTarget, "threadId" | "itemId"> | null | undefined,
): boolean {
  if (target == null) return false;
  const matches = (
    row: { readonly sourceThreadId: ThreadId; readonly sourceItemId: TurnItemId } | undefined,
  ) => row?.sourceThreadId === target.threadId && row.sourceItemId === target.itemId;
  return entry.type === "message"
    ? matches(entry.message.projectedItem)
    : entry.type === "activity-group" &&
        entry.activities.some((activity) => matches(activity.projectedItem));
}

/** Identify the disclosures that hide a selected message or plan. */
export function threadFindReveal(
  feed: ReadonlyArray<ThreadFeedEntry>,
  target: Pick<ThreadFindTarget, "threadId" | "itemId"> | null | undefined,
) {
  let runlessRunId: RunId | null = null;
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "user") {
      runlessRunId = entry.message.runId == null ? RunId.make(`runless:${entry.id}`) : null;
    }
    if (!isThreadFindTarget(entry, target)) continue;
    if (entry.type === "message") {
      return { runId: entry.message.runId ?? runlessRunId, activityId: null };
    }
    if (entry.type === "activity-group") {
      const activity = entry.activities.find(
        (activity) =>
          activity.projectedItem.sourceThreadId === target?.threadId &&
          activity.projectedItem.sourceItemId === target.itemId,
      );
      return { runId: entry.runId ?? runlessRunId, activityId: activity?.id ?? null };
    }
  }
  return null;
}

export function threadFindSnippetParts(match: OrchestrationThreadMessageSearchMatch) {
  const start = match.start - match.snippetStart;
  const end = match.end - match.snippetStart;
  return {
    before: match.snippet.slice(0, start),
    match: match.snippet.slice(start, end),
    after: match.snippet.slice(end),
  };
}
