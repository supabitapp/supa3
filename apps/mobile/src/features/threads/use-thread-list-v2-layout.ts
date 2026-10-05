import type { EnvironmentId } from "@supacode/contracts";
import { useMemo } from "react";

import { computeThreadMoveAvailability } from "./threadOrder";
import {
  buildThreadListV2Items,
  getThreadListV2OrderedSection,
  threadListInboxReturns,
} from "./threadListV2";

type ThreadListV2LayoutInput = Required<
  Omit<Parameters<typeof buildThreadListV2Items>[0], "inboxReturnAt">
> & {
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly activeReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
};

/** Keeps Home and the iPad sidebar on the same partition and reordering policy. */
export function useThreadListV2Layout({
  threads,
  environmentId,
  projectRefs,
  searchQuery,
  matchedThreadKeys,
  pendingOrder,
  settlementEnvironmentIds,
  snoozeEnvironmentIds,
  queuedThreadKeys,
  settledLimit,
  now,
  workingShelfEnabled,
  workingShelfExpanded,
  snoozedShelfExpanded,
  settledShelfExpanded,
  selectedThreadKey,
  pinReorderEnvironmentIds,
  activeReorderEnvironmentIds,
}: ThreadListV2LayoutInput) {
  // Compute once per section rather than probing the move planner for every row.
  const threadMoveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: threads,
        section,
        pendingOrder,
        reorderableEnvironmentIds:
          section === "pinned" ? pinReorderEnvironmentIds : activeReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads,
          section,
          pendingOrder,
          now,
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    // The Working beta orders the inbox by time, so only pins can move.
    return new Map([
      ...sectionAvailability("pinned"),
      ...(workingShelfEnabled ? [] : sectionAvailability("active")),
    ]);
  }, [
    workingShelfEnabled,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    threads,
    pendingOrder,
    queuedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    now,
  ]);
  const threadListV2Layout = useMemo(() => {
    threadListInboxReturns.observe(workingShelfEnabled ? threads : null);
    // Settled threads remain live shells; archived threads stay hidden.
    return buildThreadListV2Items({
      pendingOrder,
      threads: threads.filter((thread) => thread.archivedAt === null),
      environmentId,
      projectRefs,
      searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      settledLimit,
      now,
      workingShelfEnabled,
      workingShelfExpanded,
      inboxReturnAt: threadListInboxReturns.returnedAt,
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey,
    });
  }, [
    workingShelfEnabled,
    workingShelfExpanded,
    pendingOrder,
    queuedThreadKeys,
    now,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey,
    environmentId,
    searchQuery,
    matchedThreadKeys,
    settledLimit,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    threads,
    projectRefs,
  ]);
  return { threadMoveAvailability, threadListV2Layout };
}
