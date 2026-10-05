import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useThreadFeedLoading } from "./use-thread-feed-loading";

type Input = Parameters<typeof useThreadFeedLoading>[0];
const initialInput: Input = {
  threadKey: "environment:thread",
  listMountKey: "environment:thread:empty",
  contentKind: "loading",
  hasContent: false,
  hasQueuedMessages: false,
};

let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useThreadFeedLoading>;

function Probe(props: { input: Input }) {
  const state = useThreadFeedLoading(props.input);
  useLayoutEffect(() => {
    result = state;
  });
  return null;
}

async function render(input: Input) {
  await act(async () => {
    if (renderer) renderer.update(<Probe input={input} />);
    else renderer = create(<Probe input={input} />);
  });
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("thread feed loading handoff", () => {
  it("waits for the filled list to land even if the empty list already loaded", async () => {
    await render(initialInput);
    await act(async () => result.onListLoaded());
    expect(result.loading).toBe(true);
    const filled = {
      ...initialInput,
      contentKind: "ready",
      hasContent: true,
      listMountKey: "environment:thread:filled",
    } as const;
    await render(filled);
    expect(result.loading).toBe(true);
    await act(async () => result.onListLoaded());
    expect(result.loading).toBe(false);
    await render({ ...filled, listMountKey: "another-list-mount" });
    expect(result.loading).toBe(false);
  });

  it("shows cached conversations immediately", async () => {
    await render({ ...initialInput, contentKind: "ready", hasContent: true });
    expect(result.loading).toBe(false);
  });

  it("waits for a new list when the same thread loads again", async () => {
    const filled = {
      ...initialInput,
      contentKind: "ready",
      hasContent: true,
      listMountKey: "environment:thread:filled",
    } as const;
    await render(filled);
    await act(async () => result.onListLoaded());
    await render(initialInput);
    await render(filled);
    expect(result.loading).toBe(true);
    await act(async () => result.onListLoaded());
    expect(result.loading).toBe(false);
  });

  it("reveals an empty conversation without waiting for a list callback", async () => {
    await render(initialInput);
    await render({ ...initialInput, contentKind: "ready" });
    expect(result.loading).toBe(false);
    await render({
      ...initialInput,
      contentKind: "ready",
      hasContent: true,
      listMountKey: "filled",
    });
    expect(result.loading).toBe(false);
  });

  it("keeps queued messages visible while history loads", async () => {
    await render({ ...initialInput, hasQueuedMessages: true });
    expect(result.loading).toBe(false);
  });

  it("clears the loader when history becomes unavailable", async () => {
    await render(initialInput);
    await render({ ...initialInput, contentKind: "unavailable" });
    expect(result.loading).toBe(false);
  });

  it("ignores a previous thread's late list callback", async () => {
    await render(initialInput);
    const previousOnLoad = result.onListLoaded;
    const next = {
      ...initialInput,
      threadKey: "other:thread",
      listMountKey: "other:thread:filled",
      hasContent: true,
    };
    await render(next);
    await render({ ...next, contentKind: "ready" });
    await act(async () => previousOnLoad());
    expect(result.loading).toBe(true);
    await act(async () => result.onListLoaded());
    expect(result.loading).toBe(false);
  });
});
