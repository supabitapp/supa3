import { describe, expect, it } from "vite-plus/test";
import { canMoveThreadToActive, threadDragAction, threadOrderAfterMove } from "./threadOrder";
import { threadDragGapOffset } from "./threadDragGap";

describe("live thread insertion gap", () => {
  // Header, pinned row, Active header, two active rows. Geometry stays fixed for hit testing.
  const offsets = [0, 48, 120, 168, 240];
  const shifts = (source: number, insertion: number) =>
    offsets.map((offset) => threadDragGapOffset(offset, source, 72, insertion));

  it("moves the Active header and intervening rows up when unpinning", () => {
    expect(shifts(48, 312)).toEqual([0, 0, -72, -72, -72]);
  });
  it("opens a full gap below the Pinned header when pinning", () => {
    expect(shifts(240, 48)).toEqual([0, 72, 72, 72, 0]);
  });
  it("leaves the source gap in place for cancellation or its current destination", () => {
    expect(shifts(168, 168)).toEqual([0, 0, 0, 0, 0]);
    expect(shifts(168, 240)).toEqual([0, 0, 0, 0, 0]);
  });
  it("moves only crossed rows for an adjacent reorder", () => {
    expect(shifts(168, 312)).toEqual([0, 0, 0, 0, -72]);
    expect(shifts(240, 168)).toEqual([0, 0, 0, 72, 0]);
  });
});

describe("moving into the time-ordered inbox", () => {
  const supported = {
    threadPinning: true,
    threadSettlement: true,
    threadSnooze: true,
  };
  const unpinned = { pinnedAt: null };
  const pinned = { pinnedAt: "2026-06-01T00:00:00.000Z" };

  it("accepts threads from other sections without a slot", () => {
    expect(canMoveThreadToActive(pinned, "pinned", supported)).toBe(true);
    expect(canMoveThreadToActive(unpinned, "settled", supported)).toBe(true);
    expect(canMoveThreadToActive(pinned, "snoozed", supported)).toBe(true);
    expect(canMoveThreadToActive(unpinned, "active", supported)).toBe(false);
  });
  it("requires the capability for each lifecycle change", () => {
    expect(canMoveThreadToActive(pinned, "pinned", { ...supported, threadPinning: false })).toBe(
      false,
    );
    expect(
      canMoveThreadToActive(unpinned, "settled", { ...supported, threadSettlement: false }),
    ).toBe(false);
    expect(canMoveThreadToActive(unpinned, "snoozed", { ...supported, threadSnooze: false })).toBe(
      false,
    );
    expect(canMoveThreadToActive(pinned, "snoozed", { ...supported, threadPinning: false })).toBe(
      false,
    );
    expect(canMoveThreadToActive(unpinned, "settled", undefined)).toBe(false);
  });
});

describe("drag action labels", () => {
  it("names the action for each destination instead of its section", () => {
    expect(threadDragAction("active", "pinned")).toBe("Pin");
    expect(threadDragAction("pinned", "active")).toBe("Unpin");
    expect(threadDragAction("settled", "active")).toBe("Unsettle");
    expect(threadDragAction("snoozed", "active")).toBe("Unsnooze");
    expect(threadDragAction("active", "settled")).toBe("Settle");
    expect(threadDragAction("pinned", "settled")).toBe("Settle");
    expect(threadDragAction("active", "active")).toBe("Reorder");
  });
  it("does not offer a parked-section reorder or snooze without a wake time", () => {
    expect(threadDragAction("settled", "settled")).toBeNull();
    expect(threadDragAction("active", "snoozed")).toBeNull();
    expect(
      threadOrderAfterMove(["a", "b"], "a", {
        section: "settled",
        targetId: null,
        placement: "before",
      }),
    ).toBeNull();
  });
});
