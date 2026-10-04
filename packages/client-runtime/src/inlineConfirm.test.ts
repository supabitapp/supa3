import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createInlineConfirm,
  INLINE_CONFIRM_GUARD_MS,
  INLINE_CONFIRM_TIMEOUT_MS,
} from "./inlineConfirm.ts";

function track() {
  const changes: Array<string | null> = [];
  const confirm = createInlineConfirm<"remove" | "retry">((armed) => changes.push(armed));
  return { changes, confirm };
}

describe("createInlineConfirm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms only a second press of the same key after the guard", () => {
    const { changes, confirm } = track();
    expect(confirm.press("remove", 1_000)).toBe(false);
    expect(confirm.press("remove", 1_000 + INLINE_CONFIRM_GUARD_MS - 1)).toBe(false);
    expect(changes).toEqual(["remove"]);
    expect(confirm.press("remove", 1_000 + INLINE_CONFIRM_GUARD_MS)).toBe(true);
    expect(changes).toEqual(["remove", null]);
    expect(confirm.press("remove", 2_000)).toBe(false);
    expect(changes.at(-1)).toBe("remove");
  });

  it("moves the arming to another key instead of confirming it", () => {
    const { changes, confirm } = track();
    confirm.press("remove", 0);
    expect(confirm.press("retry", 1_000)).toBe(false);
    expect(confirm.press("retry", 1_000 + INLINE_CONFIRM_GUARD_MS - 1)).toBe(false);
    expect(confirm.press("retry", 1_000 + INLINE_CONFIRM_GUARD_MS)).toBe(true);
    expect(changes).toEqual(["remove", "retry", null]);
  });

  it("disarms after the timeout, restarted by each new arming", () => {
    const { changes, confirm } = track();
    confirm.press("remove", 0);
    vi.advanceTimersByTime(INLINE_CONFIRM_TIMEOUT_MS - 1);
    confirm.press("retry", 0);
    vi.advanceTimersByTime(INLINE_CONFIRM_TIMEOUT_MS - 1);
    expect(changes).toEqual(["remove", "retry"]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual(["remove", "retry", null]);
    expect(confirm.press("retry", INLINE_CONFIRM_TIMEOUT_MS * 2)).toBe(false);
  });

  it("disarms on request, or only when the given key is the armed one", () => {
    const { changes, confirm } = track();
    confirm.disarm();
    confirm.press("remove", 0);
    confirm.disarm("retry");
    expect(changes).toEqual(["remove"]);
    confirm.disarm("remove");
    confirm.press("retry", 0);
    confirm.disarm();
    expect(changes).toEqual(["remove", null, "retry", null]);
    vi.runAllTimers();
    expect(changes.at(-1)).toBeNull();
    expect(changes).toHaveLength(4);
  });
});
