import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@supacode/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeThreadProjectionFixture, makeStreamingTimelineFixture } from "../../test-fixtures";
import { threadSearchWindowContainsMatch } from "@supacode/client-runtime/state/thread-search";
import { useThreadFind } from "./useThreadFind";

type LoadedWindow = {
  readonly _tag: "Success";
  readonly value: { readonly _tag: "loaded"; readonly projection: OrchestrationV2ThreadProjection };
};
const mocks = vi.hoisted(() => ({
  loadAround: vi.fn<() => Promise<LoadedWindow>>(),
  onClose: vi.fn(),
  onManualNavigation: vi.fn<() => void | (() => void)>(),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { loadAroundHistory: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.loadAround }));
vi.mock("../../threadFindBus", () => ({ onOpenThreadFind: () => () => {} }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const match = {
  index: 0,
  threadId: threadRef.threadId,
  itemId: TurnItemId.make("older-item"),
  start: 0,
  end: 6,
  snippetStart: 0,
  snippet: "needle",
};
let renderer: ReactTestRenderer | null = null;
let current: ReturnType<typeof useThreadFind>;
function Probe(props: { readonly onResult: (result: ReturnType<typeof useThreadFind>) => void }) {
  props.onResult(
    useThreadFind({
      threadRef,
      threadKey: "environment:thread",
      isServerThread: true,
      onManualNavigation: mocks.onManualNavigation,
      onClose: mocks.onClose,
    }),
  );
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.loadAround.mockReset();
  mocks.onClose.mockClear();
  mocks.onManualNavigation.mockReset();
  act(() => {
    renderer = create(
      <Probe
        onResult={(result) => {
          current = result;
        }}
      />,
    );
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("current-thread find history window", () => {
  it("reuses an unloaded message window across typing and occurrences, and invalidates it on refresh", async () => {
    const row = makeStreamingTimelineFixture("needle needle").visibleTurnItems.at(-1)!;
    const projection = {
      ...makeThreadProjectionFixture(),
      visibleTurnItems: [{ ...row, sourceThreadId: match.threadId, sourceItemId: match.itemId }],
    };
    mocks.loadAround.mockResolvedValue({ _tag: "Success", value: { _tag: "loaded", projection } });
    act(() => current.open());
    await act(async () => current.navigate(match, "n"));
    await act(async () => current.navigate(match, "ne"));
    await act(async () =>
      current.navigate(
        { ...match, index: 1, start: 7, end: 13, snippet: "needle needle" },
        "needle",
      ),
    );
    expect(mocks.loadAround).toHaveBeenCalledTimes(1);
    expect(current.request?.projection).toBe(projection);
    act(() => current.invalidateWindow());
    await act(async () => current.navigate(match, "needle"));
    expect(mocks.loadAround).toHaveBeenCalledTimes(2);
    expect(
      threadSearchWindowContainsMatch(projection.visibleTurnItems, {
        ...match,
        snippet: "newer persisted text",
      }),
    ).toBe(false);
    await act(async () => current.navigate({ ...match, snippet: "newer persisted text" }, "newer"));
    expect(mocks.loadAround).toHaveBeenCalledTimes(3);
  });
  it("restores the original live-follow state after navigating between matches", async () => {
    let following = true;
    mocks.onManualNavigation.mockImplementation(() => {
      const previous = following;
      following = false;
      return () => {
        following = previous;
      };
    });
    mocks.loadAround.mockResolvedValue({
      _tag: "Success",
      value: { _tag: "loaded", projection: makeThreadProjectionFixture() },
    });
    act(() => current.open());
    await act(async () => current.navigate(match, "needle"));
    expect(following).toBe(false);
    await act(async () => current.navigate({ ...match, index: 1 }, "needle"));
    act(() => current.close());
    expect(following).toBe(true);
    expect(current.request).toBeNull();
  });
  it("shows the isolated result window and returns to recent history on close", async () => {
    const projection = makeThreadProjectionFixture();
    mocks.loadAround.mockResolvedValue({ _tag: "Success", value: { _tag: "loaded", projection } });
    act(() => current.open());
    await act(async () => current.navigate(match, "needle"));
    expect(current.isOpen).toBe(true);
    expect(current.request?.projection).toBe(projection);
    expect(current.request?.match).toBe(match);
    act(() => current.close());
    expect(current.isOpen).toBe(false);
    expect(current.request).toBeNull();
  });

  it("cannot reinstall an old window after find is closed", async () => {
    let finish!: (value: LoadedWindow) => void;
    mocks.loadAround.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => current.open());
    act(() => current.navigate(match, "needle"));
    act(() => current.close());
    await act(async () =>
      finish({
        _tag: "Success",
        value: { _tag: "loaded", projection: makeThreadProjectionFixture() },
      }),
    );
    expect(current.isOpen).toBe(false);
    expect(current.request).toBeNull();
  });

  it("cannot refill the window cache with a load that started before refresh", async () => {
    let finish!: (value: LoadedWindow) => void;
    mocks.loadAround.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => current.open());
    act(() => current.navigate(match, "needle"));
    act(() => current.invalidateWindow());
    await act(async () =>
      finish({
        _tag: "Success",
        value: { _tag: "loaded", projection: makeThreadProjectionFixture() },
      }),
    );
    expect(current.request).toBeNull();
  });
});
