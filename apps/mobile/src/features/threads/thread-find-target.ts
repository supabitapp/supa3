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
  target: ThreadFindTarget | null | undefined,
): boolean {
  return (
    target != null &&
    entry.type === "message" &&
    entry.message.projectedItem?.sourceThreadId === target.threadId &&
    entry.message.projectedItem.sourceItemId === target.itemId
  );
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
