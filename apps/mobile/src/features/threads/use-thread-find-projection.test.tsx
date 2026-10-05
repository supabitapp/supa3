import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  MessageId,
  TurnItemId,
  type OrchestrationThreadMessageSearchMatch,
  type OrchestrationV2TurnItem,
} from "@supacode/contracts";
import type { ThreadHistoryLoadAroundResult } from "@supacode/client-runtime/state/threads";
import {
  v2Projection,
  v2ThreadId,
  v2Now,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { useThreadFindProjection } from "./use-thread-find-projection";

const item: OrchestrationV2TurnItem = {
  id: TurnItemId.make("older-message"),
  type: "assistant_message",
  threadId: v2ThreadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  messageId: MessageId.make("message"),
  text: "needle needle",
  attachments: [],
  streaming: false,
};
const projection = {
  ...v2Projection,
  turnItems: [item],
  visibleTurnItems: [
    {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: v2ThreadId,
      sourceItemId: item.id,
      item,
    },
  ],
};
const match: OrchestrationThreadMessageSearchMatch = {
  index: 0,
  threadId: v2ThreadId,
  itemId: item.id,
  start: 0,
  end: 6,
  snippetStart: 0,
  snippet: item.text,
};
let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useThreadFindProjection>;
function Probe(props: {
  load: (match: OrchestrationThreadMessageSearchMatch) => Promise<ThreadHistoryLoadAroundResult>;
}) {
  const current = useThreadFindProjection(props.load);
  useLayoutEffect(() => {
    result = current;
  });
  return null;
}
async function render(
  load: (match: OrchestrationThreadMessageSearchMatch) => Promise<ThreadHistoryLoadAroundResult>,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<Probe load={load} />);
  });
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("mobile thread find bounded snapshot reuse", () => {
  it("keeps occurrences in the same old window on one download until Refresh invalidates it", async () => {
    const load = vi.fn(async () => ({ _tag: "loaded" as const, projection }));
    await render(load);
    expect(await result.loadProjection(match)).toEqual({ _tag: "loaded", projection });
    expect(await result.loadProjection({ ...match, index: 1, start: 7, end: 13 })).toEqual({
      _tag: "loaded",
      projection,
    });
    expect(load).toHaveBeenCalledTimes(1);
    result.invalidateProjection();
    await result.loadProjection(match);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("refetches when the server's current raw snippet no longer matches the cached message", async () => {
    const load = vi.fn(async () => ({ _tag: "loaded" as const, projection }));
    await render(load);
    await result.loadProjection(match);
    await result.loadProjection({ ...match, snippet: "updated needle", start: 8, end: 14 });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not repopulate the cache with an older request that finishes after invalidation", async () => {
    let complete: (value: ThreadHistoryLoadAroundResult) => void = () => {
      throw new Error("Request not started");
    };
    const load = vi.fn(
      () =>
        new Promise<ThreadHistoryLoadAroundResult>((resolve) => {
          complete = resolve;
        }),
    );
    await render(load);
    const old = result.loadProjection(match);
    result.invalidateProjection();
    complete({ _tag: "loaded", projection });
    await old;
    const next = result.loadProjection(match);
    expect(load).toHaveBeenCalledTimes(2);
    complete({ _tag: "loaded", projection });
    await next;
  });
});
