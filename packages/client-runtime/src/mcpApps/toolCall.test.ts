import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@supacode/contracts";
import { MAX_TOOL_OUTPUT_IMAGES } from "@supacode/shared/toolOutput";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { hydrateMcpAppToolCall, makeMcpAppImageReader } from "./toolCall.ts";

const app = {
  attachmentId: "thread-1-app-html",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
};
const item = (result: unknown) =>
  ({
    id: TurnItemId.make("app-call"),
    threadId: ThreadId.make("app-thread"),
    type: "dynamic_tool",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    toolName: "weather.get_weather",
    input: { city: "Oslo" },
    output: { supacodeMcpApp: app, result },
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
  }) satisfies OrchestrationV2TurnItem;

describe("hydrateMcpAppToolCall", () => {
  it("hydrates image markers from the item's assets while preserving result data and order", async () => {
    const result = {
      content: [
        { type: "text", text: "Sunny" },
        { type: "image", mimeType: "image/png" },
        { type: "text", text: "Warmer tomorrow" },
        { type: "image", mimeType: "image/jpeg" },
      ],
      structuredContent: { temperature: 21 },
      _meta: { private: "state" },
    };
    const resources: Array<unknown> = [];
    const hydrated = await hydrateMcpAppToolCall({
      item: item(result),
      readImage: async (resource) => {
        resources.push(resource);
        return new Uint8Array([resource.index + 1]);
      },
    });
    expect(resources).toEqual([
      { _tag: "tool-output-image", threadId: "app-thread", itemId: "app-call", index: 0 },
      { _tag: "tool-output-image", threadId: "app-thread", itemId: "app-call", index: 1 },
    ]);
    expect(hydrated).toEqual({
      arguments: { city: "Oslo" },
      result: {
        ...result,
        content: [
          result.content[0],
          { type: "image", mimeType: "image/png", data: "AQ==" },
          result.content[2],
          { type: "image", mimeType: "image/jpeg", data: "Ag==" },
        ],
      },
    });
    expect(result.content[1]).not.toHaveProperty("data");
  });

  it("reports unreadable images without losing the remaining result or sending invalid image blocks", async () => {
    const hydrated = await hydrateMcpAppToolCall({
      item: item({
        content: [{ type: "image", mimeType: "image/png" }],
        structuredContent: { temperature: 21 },
      }),
      readImage: async () => {
        throw new Error("Asset expired");
      },
    });
    expect(hydrated?.result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("could not be loaded") }],
      structuredContent: { temperature: 21 },
      isError: true,
    });
  });

  it("returns an explicit MCP error for unavailable results from an older detail projection", async () => {
    const hydrated = await hydrateMcpAppToolCall({
      item: { ...item(undefined), output: "truncated tool output" },
      readImage: async () => new Uint8Array(),
    });
    expect(hydrated?.result).toEqual({
      content: [{ type: "text", text: "The app's original tool result is unavailable." }],
      isError: true,
    });
  });

  it("does not publish a replay cancelled during image loading", async () => {
    const controller = new AbortController();
    const hydrated = await hydrateMcpAppToolCall({
      item: item({ content: [{ type: "image", mimeType: "image/png" }] }),
      signal: controller.signal,
      readImage: async (_resource, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        return new Uint8Array([1]);
      },
    });
    expect(hydrated).toBeUndefined();
  });

  it("bounds image loading by the asset count and image byte limits", async () => {
    let reads = 0;
    const bytes = new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
    const hydrated = await hydrateMcpAppToolCall({
      item: item({
        content: Array.from({ length: MAX_TOOL_OUTPUT_IMAGES + 1 }, () => ({
          type: "image",
          mimeType: "image/png",
        })),
      }),
      readImage: async () => {
        reads += 1;
        return bytes;
      },
    });
    expect(reads).toBe(MAX_TOOL_OUTPUT_IMAGES);
    expect(hydrated?.result.isError).toBe(true);
    expect(
      hydrated?.result.content.every(
        (block) =>
          typeof block === "object" && block !== null && "type" in block && block.type === "text",
      ),
    ).toBe(true);
  });
});

describe("makeMcpAppImageReader", () => {
  const resource = {
    _tag: "tool-output-image" as const,
    threadId: ThreadId.make("app-thread"),
    itemId: TurnItemId.make("app-call"),
    index: 0,
  };

  it("downloads image bytes from the destination environment's signed URL", async () => {
    const controller = new AbortController();
    const reader = makeMcpAppImageReader({
      createUrl: async (requested) => {
        expect(requested).toEqual(resource);
        return AsyncResult.success({ relativeUrl: "/api/assets/signed/image.png", expiresAt: 1 });
      },
      httpBaseUrl: "http://remote.test:43100",
      fetch: async (url, options) => {
        expect(url).toBe("http://remote.test:43100/api/assets/signed/image.png");
        expect(options?.signal).toBe(controller.signal);
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    expect(await reader(resource, controller.signal)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses failed URL grants before fetching and rejects failed image responses", async () => {
    let fetches = 0;
    const fetch = async () => {
      fetches += 1;
      return new Response(null, { status: 403 });
    };
    const denied = makeMcpAppImageReader({
      createUrl: async () => AsyncResult.failure(Cause.fail(new Error("Access denied"))),
      httpBaseUrl: "http://remote.test:43100",
      fetch,
    });
    await expect(denied(resource)).rejects.toThrow("Access denied");
    expect(fetches).toBe(0);
    const failed = makeMcpAppImageReader({
      createUrl: async () =>
        AsyncResult.success({ relativeUrl: "/api/assets/signed/image.png", expiresAt: 1 }),
      httpBaseUrl: "http://remote.test:43100",
      fetch,
    });
    await expect(failed(resource)).rejects.toThrow("could not be downloaded");
    expect(fetches).toBe(1);
  });
});
