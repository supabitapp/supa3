import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CONNECTION_STATUS_DELAY_MS, createConnectionStatusDelay } from "./status-delay";

describe("connection status delay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const changed = vi.fn();
    const delay = createConnectionStatusDelay(changed);
    const update = (overrides: Partial<Parameters<typeof delay.update>[0]> = {}) =>
      delay.update({
        key: "environment:1",
        pending: true,
        active: true,
        immediate: false,
        ...overrides,
      });
    return { changed, delay, update };
  };

  it("keeps quick reconnects quiet and clears settled status immediately", () => {
    const { changed, update } = setup();
    update();
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS - 1);
    update({ pending: false });
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changed).not.toHaveBeenCalledWith("environment:1");
    update();
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changed).toHaveBeenLastCalledWith("environment:1");
    update({ pending: false });
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it("starts a fresh display delay after foregrounding", () => {
    const { changed, delay, update } = setup();
    update();
    vi.advanceTimersByTime(1_000);
    delay.pause();
    update({ active: false });
    vi.advanceTimersByTime(60_000);
    expect(changed).not.toHaveBeenCalledWith("environment:1");
    update({ key: "environment:2" });
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS - 1);
    expect(changed).not.toHaveBeenCalledWith("environment:2");
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenLastCalledWith("environment:2");
  });

  it("shows actionable errors without waiting through the recovery delay", () => {
    const { changed, update } = setup();
    update();
    update({ immediate: true });
    expect(changed).toHaveBeenLastCalledWith("environment:1");
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changed.mock.calls.filter(([value]) => value === "environment:1")).toHaveLength(1);
  });

  it("cancels a previous environment's display timer", () => {
    const { changed, update } = setup();
    update();
    vi.advanceTimersByTime(1_000);
    update({ key: "other" });
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changed).not.toHaveBeenCalledWith("environment:1");
    expect(changed).toHaveBeenLastCalledWith("other");
  });

  it("can restart after disposal without leaking a timer", () => {
    const { changed, delay, update } = setup();
    update();
    delay.dispose();
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changed).not.toHaveBeenCalledWith("environment:1");
    update();
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changed).toHaveBeenLastCalledWith("environment:1");
  });
});
