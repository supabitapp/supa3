import type { LegendListRef } from "@legendapp/list/react";
import type {
  OrchestrationThreadMessageSearchMatch,
  RunAttemptId,
  RunId,
} from "@supacode/contracts";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface ThreadFindRequest {
  readonly key: string;
  readonly match: OrchestrationThreadMessageSearchMatch;
}

export function findThreadSearchEntry(
  entries: ReadonlyArray<TimelineEntry>,
  match: Pick<OrchestrationThreadMessageSearchMatch, "threadId" | "itemId">,
) {
  return entries.find(
    (entry) =>
      (entry.kind === "message" || entry.kind === "proposed-plan") &&
      entry.projectedItem?.sourceItemId === match.itemId &&
      entry.projectedItem.sourceThreadId === match.threadId,
  );
}

/** Unfold and mount just the selected server occurrence before positioning it. */
export function useThreadFindTarget(options: {
  readonly request: ThreadFindRequest | null;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly viewport: HTMLElement | null;
  readonly onExpandTurn: (runId: RunId) => void;
  readonly onExpandAttempt: (attemptId: RunAttemptId) => void;
  readonly onManualNavigation: () => void;
}) {
  const source = useMemo(
    () =>
      options.request ? findThreadSearchEntry(options.entries, options.request.match) : undefined,
    [options.entries, options.request],
  );
  const row = source ? options.rows.find((candidate) => candidate.id === source.id) : undefined;
  const positionedKey = useRef<string | null>(null);
  const { request, viewport, listRef, onExpandTurn, onExpandAttempt, onManualNavigation } = options;
  useEffect(() => {
    if (!request || !source || !viewport) return;
    if (row === undefined) {
      const runId =
        source.kind === "message"
          ? source.message.runId
          : source.kind === "proposed-plan"
            ? source.proposedPlan.runId
            : null;
      if (runId) onExpandTurn(runId);
      if (source.attempt) onExpandAttempt(source.attempt.id);
      return;
    }
    if (positionedKey.current === request.key) return;
    const list = listRef.current;
    const index = options.rows.indexOf(row);
    if (!list || index < 0) return;
    positionedKey.current = request.key;
    onManualNavigation();
    void list.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: 24 });
  }, [
    request,
    source,
    row,
    viewport,
    listRef,
    options.rows,
    onExpandTurn,
    onExpandAttempt,
    onManualNavigation,
  ]);
  return {
    rowId: row?.id ?? null,
    alwaysRender: row ? { keys: [row.id] } : undefined,
  };
}
