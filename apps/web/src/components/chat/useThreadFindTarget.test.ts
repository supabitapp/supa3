import { ThreadId, TurnItemId } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { findThreadSearchEntry } from "./useThreadFindTarget";

describe("findThreadSearchEntry", () => {
  it("resolves a source item whose displayed message has a different ID", () => {
    const fixture = makeStreamingTimelineFixture();
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: fixture.visibleTurnItems,
      optimisticMessages: [],
    });
    const target = findThreadSearchEntry(entries, {
      threadId: fixture.threadId,
      itemId: TurnItemId.make("history-assistant-item"),
    });
    expect(target?.id).toBe("history-assistant");
  });

  it("distinguishes inherited source threads before jumping to a message", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find(
      (row) => row.sourceItemId === "history-assistant-item",
    )!;
    const ancestor = ThreadId.make("ancestor");
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [{ ...source, visibility: "inherited", sourceThreadId: ancestor }],
      optimisticMessages: [],
    });
    expect(
      findThreadSearchEntry(entries, { threadId: fixture.threadId, itemId: source.sourceItemId }),
    ).toBeUndefined();
    expect(
      findThreadSearchEntry(entries, { threadId: ancestor, itemId: source.sourceItemId })?.id,
    ).toBe("history-assistant");
  });
});
