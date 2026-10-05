import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  TurnItemId,
  MessageId,
  PlanId,
  RunId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import { buildThreadFeed, deriveThreadFeedPresentation } from "../../lib/threadActivity";
import { isThreadFindTarget, threadFindReveal, threadFindSnippetParts } from "./thread-find-target";

describe("threadFindSnippetParts", () => {
  it("highlights the selected raw UTF-16 occurrence with the server snippet offset", () => {
    expect(
      threadFindSnippetParts({
        index: 1,
        threadId: ThreadId.make("thread"),
        itemId: TurnItemId.make("message"),
        snippet: "😀 **needle** needle",
        snippetStart: 100,
        start: 114,
        end: 120,
      }),
    ).toEqual({ before: "😀 **needle** ", match: "needle", after: "" });
  });
});

const currentThread = ThreadId.make("current");
const ancestorThread = ThreadId.make("ancestor");
const timestamp = DateTime.makeUnsafe("2026-09-08T00:00:00.000Z");

function findRow(
  item: OrchestrationV2TurnItem,
  position: number,
): OrchestrationV2ProjectedTurnItem {
  return {
    item,
    position,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: item.threadId === currentThread ? "local" : "inherited",
  };
}

function baseFindItem(id: string, sourceThreadId: ThreadId, runId: RunId | null, ordinal: number) {
  return {
    id: TurnItemId.make(id),
    threadId: sourceThreadId,
    runId,
    ordinal,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("finding plans in the mobile feed", () => {
  it.each([currentThread, ancestorThread])(
    "reveals a plan in collapsed run and work groups from %s",
    (source) => {
      const runId = RunId.make("found-run");
      const plan: OrchestrationV2TurnItem = {
        ...baseFindItem("found-plan", source, runId, 2),
        type: "proposed_plan",
        planId: PlanId.make("plan"),
        markdown: "A searchable plan",
        streaming: false,
      };
      const feed = buildThreadFeed([
        findRow(
          {
            ...baseFindItem("prompt", source, runId, 0),
            type: "user_message",
            messageId: MessageId.make("prompt"),
            createdBy: "user",
            creationSource: "mobile",
            inputIntent: "turn_start",
            text: "Make a plan",
            attachments: [],
          },
          0,
        ),
        findRow(
          {
            ...baseFindItem("command", source, runId, 1),
            type: "command_execution",
            input: "pwd",
            output: "/repo",
            exitCode: 0,
          },
          1,
        ),
        findRow(plan, 2),
        findRow(
          {
            ...baseFindItem("answer", source, runId, 3),
            type: "assistant_message",
            messageId: MessageId.make("answer"),
            text: "Plan ready",
            attachments: [],
            streaming: false,
          },
          3,
        ),
      ]);
      const target = { threadId: source, itemId: plan.id };
      expect(
        deriveThreadFeedPresentation(feed, null, new Set()).some((entry) =>
          isThreadFindTarget(entry, target),
        ),
      ).toBe(false);
      const reveal = threadFindReveal(feed, target);
      expect(reveal).toMatchObject({
        runId,
        activityId: `${source === currentThread ? "local" : "inherited"}:${source}:${plan.id}`,
      });
      const shown = deriveThreadFeedPresentation(
        feed,
        null,
        new Set([reveal!.runId!]),
        new Set(),
        null,
        false,
        reveal!.activityId,
      );
      const index = shown.findIndex((entry) => isThreadFindTarget(entry, target));
      expect(index).toBeGreaterThan(-1);
      const selected = shown[index]!;
      expect(selected.type).toBe("activity-group");
      expect(
        isThreadFindTarget(selected, { ...target, threadId: ThreadId.make("unrelated") }),
      ).toBe(false);
      if (selected.type === "activity-group") {
        expect(
          selected.activities
            .find((activity) => activity.id === reveal?.activityId)
            ?.getFullDetail(),
        ).toContain("A searchable plan");
      }
      expect(
        deriveThreadFeedPresentation(feed, null, new Set([runId])).some((entry) =>
          isThreadFindTarget(entry, target),
        ),
      ).toBe(false);
    },
  );
});
