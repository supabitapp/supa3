import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useThreadOutboxVisibility } from "./useThreadOutboxVisibility";

let renderer: ReactTestRenderer;
let open = false;

function Probe({
  scope = "environment:thread",
  hasPending = true,
  needsAttention = false,
}: {
  scope?: string;
  hasPending?: boolean;
  needsAttention?: boolean;
}) {
  const visible = useThreadOutboxVisibility(scope, hasPending, needsAttention);
  useLayoutEffect(() => {
    open = visible;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("never opens for a message delivered within one second", () => {
  expect(open).toBe(false);
  act(() => vi.advanceTimersByTime(999));
  expect(open).toBe(false);
  act(() => renderer.update(<Probe hasPending={false} />));
  act(() => vi.runAllTimers());
  expect(open).toBe(false);
});

it("shows a delayed message without restarting the grace period on updates", () => {
  act(() => vi.advanceTimersByTime(500));
  act(() => renderer.update(<Probe />));
  act(() => vi.advanceTimersByTime(499));
  expect(open).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(open).toBe(true);
});

it("closes on delivery and gives the next message a fresh grace period", () => {
  act(() => vi.advanceTimersByTime(1_000));
  expect(open).toBe(true);
  act(() => renderer.update(<Probe hasPending={false} />));
  expect(open).toBe(false);
  act(() => renderer.update(<Probe />));
  expect(open).toBe(false);
  act(() => vi.advanceTimersByTime(999));
  expect(open).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(open).toBe(true);
});

it("shows failures immediately and keeps the drawer open while retrying or editing", () => {
  act(() => renderer.update(<Probe needsAttention />));
  expect(open).toBe(true);
  act(() => renderer.update(<Probe />));
  expect(open).toBe(true);
  act(() => renderer.update(<Probe hasPending={false} />));
  expect(open).toBe(false);
  act(() => renderer.update(<Probe />));
  expect(open).toBe(false);
});

it("does not carry visibility or elapsed time to another thread or environment", () => {
  act(() => vi.advanceTimersByTime(1_000));
  expect(open).toBe(true);
  act(() => renderer.update(<Probe scope="another-environment:thread" />));
  expect(open).toBe(false);
  act(() => vi.advanceTimersByTime(500));
  act(() => renderer.update(<Probe scope="another-environment:another-thread" />));
  act(() => vi.advanceTimersByTime(999));
  expect(open).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(open).toBe(true);
});

it("shows an existing failure immediately when visiting its thread", () => {
  act(() => renderer.update(<Probe scope="environment:failed-thread" needsAttention />));
  expect(open).toBe(true);
});
