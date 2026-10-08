import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type AssetCreateUrlResult,
  type AssetResource,
  type McpAppCallToolResult,
  type OrchestrationV2TurnItem,
} from "@supacode/contracts";
import {
  MAX_TOOL_OUTPUT_IMAGES,
  readMcpAppToolResult,
  readToolOutputImage,
} from "@supacode/shared/toolOutput";
import * as Base64 from "effect/encoding/Base64";
import * as Predicate from "effect/Predicate";

import { resolveAssetUrl } from "../state/assets.ts";
import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";

type ToolImageResource = Extract<AssetResource, { readonly _tag: "tool-output-image" }>;

const textBlock = (text: string) => ({ type: "text" as const, text });

export function makeMcpAppImageReader(options: {
  readonly createUrl: (
    resource: ToolImageResource,
  ) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
  readonly httpBaseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}) {
  return async (resource: ToolImageResource, signal?: AbortSignal) => {
    const asset = await options.createUrl(resource);
    if (asset._tag !== "Success") throw squashAtomCommandFailure(asset);
    if (signal?.aborted) throw new Error("Loading the app was cancelled.");
    const url = resolveAssetUrl(options.httpBaseUrl, asset.value.relativeUrl);
    if (url === null) throw new Error("The app's tool image URL is unavailable.");
    const response = await options.fetch(url, signal === undefined ? {} : { signal });
    if (!response.ok) throw new Error("The app's tool image could not be downloaded.");
    return new Uint8Array(await response.arrayBuffer());
  };
}

export async function hydrateMcpAppToolCall(input: {
  readonly item: OrchestrationV2TurnItem;
  readonly readImage: (resource: ToolImageResource, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
}): Promise<{ readonly arguments: unknown; readonly result: McpAppCallToolResult } | undefined> {
  const { item, signal } = input;
  if (item.type !== "dynamic_tool" || signal?.aborted) return undefined;
  const result = readMcpAppToolResult(item.output);
  if (result === undefined) {
    return {
      arguments: item.input,
      result: {
        content: [textBlock("The app's original tool result is unavailable.")],
        isError: true,
      },
    };
  }
  let imageIndex = 0;
  let imageFailed = false;
  const content = await Promise.all(
    result.content.map(async (block) => {
      const image = readToolOutputImage(block);
      if (image === null) return block;
      const index = imageIndex++;
      if (image.data !== undefined) return block;
      try {
        if (index >= MAX_TOOL_OUTPUT_IMAGES) throw new Error("Too many tool images.");
        const bytes = await input.readImage(
          { _tag: "tool-output-image", threadId: item.threadId, itemId: item.id, index },
          signal,
        );
        if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          throw new Error("Tool image is too large.");
        }
        return {
          ...(Predicate.isObject(block) ? block : {}),
          type: "image",
          mimeType: image.mimeType,
          data: Base64.encode(bytes),
        };
      } catch {
        imageFailed = true;
        return textBlock("An image in the app's original tool result could not be loaded.");
      }
    }),
  );
  if (signal?.aborted) return undefined;
  return {
    arguments: item.input,
    result: { ...result, content, ...(imageFailed ? { isError: true } : {}) },
  };
}
