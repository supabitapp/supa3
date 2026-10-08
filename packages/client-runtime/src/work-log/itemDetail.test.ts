import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
} from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { latestToolGroupImage } from "./presentation.js";
import { turnItemOutputImages, turnItemOutputText } from "./itemDetail.ts";

const screenshot = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__supacode__device_screenshot",
  input: { deviceId: "phone" },
  // What a detail read returns: the image's position without its bytes.
  output: {
    content: [
      { type: "text", text: "Captured the home screen." },
      { type: "image", mimeType: "image/png" },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

describe("tool output images", () => {
  it("shows a screenshot as an image asset, not as text", () => {
    expect(turnItemOutputImages(screenshot)).toEqual([
      {
        _tag: "tool-output-image",
        threadId: screenshot.threadId,
        itemId: screenshot.id,
        index: 0,
      },
    ]);
    expect(turnItemOutputText(screenshot)).toBe("Captured the home screen.");
    expect(
      turnItemOutputText({ ...screenshot, output: { content: [screenshot.output.content[1]] } }),
    ).toBeNull();
  });

  it("keeps a placeholder for images it cannot show", () => {
    const output = { content: [{ type: "image", mimeType: "image/svg+xml" }] };
    expect(turnItemOutputImages({ ...screenshot, output })).toEqual([]);
    expect(turnItemOutputText({ ...screenshot, output })).toBe("[image]");
  });
});

function projectedScreenshot(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
): OrchestrationV2ProjectedTurnItem {
  const item = { ...screenshot, ...fields };
  return {
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    position: item.ordinal,
    visibility: "local",
    item,
  };
}

describe("latest tool group image", () => {
  it("keeps the last screenshot through later text-only and running calls, then replaces it", () => {
    const first = projectedScreenshot({
      output: undefined,
      outputOmitted: true,
      outputImageCount: 2,
    });
    const text = projectedScreenshot({
      id: TurnItemId.make("text"),
      output: undefined,
      outputOmitted: true,
    });
    const running = { ...text, item: { ...text.item, status: "running" as const } };
    expect(latestToolGroupImage([first, text, running])?.resource).toEqual({
      _tag: "tool-output-image",
      threadId: first.sourceThreadId,
      itemId: first.sourceItemId,
      index: 1,
    });
    const newer = projectedScreenshot({
      id: TurnItemId.make("newer"),
      output: undefined,
      outputOmitted: true,
      outputImageCount: 1,
    });
    expect(latestToolGroupImage([first, text, newer])?.resource).toEqual({
      _tag: "tool-output-image",
      threadId: newer.sourceThreadId,
      itemId: newer.sourceItemId,
      index: 0,
    });
    expect(latestToolGroupImage([text])).toBeNull();
    expect(latestToolGroupImage([])).toBeNull();
  });

  it("supports image metadata from older servers and viewed file paths", () => {
    const screenshotRow = projectedScreenshot();
    expect(latestToolGroupImage([screenshotRow])?.resource).toMatchObject({
      _tag: "tool-output-image",
      index: 0,
    });
    const file = projectedScreenshot({ output: undefined, viewedImagePath: "screens/latest.png" });
    expect(latestToolGroupImage([screenshotRow, file], "/workspace")?.resource).toEqual({
      _tag: "media-file",
      threadId: file.sourceThreadId,
      path: "/workspace/screens/latest.png",
    });
  });
});
