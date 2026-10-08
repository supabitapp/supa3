import type {
  EnvironmentId,
  McpAppCallToolInput,
  McpAppCallToolResult,
  McpAppReadResourceInput,
  McpAppReadResourceResult,
  McpAppToolInfo,
  McpAppToolInfoInput,
  McpAppUpdateModelContextInput,
  ThreadId,
  TurnItemId,
} from "@supacode/contracts";
import type { McpAppReference } from "@supacode/shared/mcpApp";
import * as Predicate from "effect/Predicate";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { McpAppHostRefusal, mcpResourceBytes, type McpAppHostOptions } from "./host.ts";

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

type AppCommand<Input, Success> = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<Success, unknown>>;

export interface McpAppActionContext {
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly conversationThreadId: ThreadId;
  };
  readonly canRead: boolean;
  readonly canOperate: boolean;
  readonly callTool: AppCommand<McpAppCallToolInput, McpAppCallToolResult>;
  readonly toolInfo: AppCommand<McpAppToolInfoInput, McpAppToolInfo>;
  readonly readResource: AppCommand<McpAppReadResourceInput, McpAppReadResourceResult>;
  readonly updateModelContext: AppCommand<McpAppUpdateModelContextInput, void>;
  readonly sendMessage: ((text: string) => Promise<void>) | undefined;
}

export interface McpAppActionApproval {
  readonly kind: "tool" | "message" | "download";
  readonly title: string;
  readonly message: string;
  readonly action: "Allow" | "Send" | "Save";
}

interface McpAppActionsOptions {
  readonly app: McpAppReference;
  readonly current: () => McpAppActionContext;
  readonly confirm: (approval: McpAppActionApproval) => Promise<boolean | undefined>;
  readonly saveFile: (file: {
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }) => Promise<void>;
}

function commandValue<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  throw new McpAppHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
}

export function makeMcpAppActions(options: McpAppActionsOptions) {
  const target = () => {
    const { environmentId, threadId, itemId } = options.current().target;
    return { environmentId, input: { threadId, itemId } };
  };
  const approve = async (approval: McpAppActionApproval) => {
    if ((await options.confirm(approval)) !== true) {
      throw new McpAppHostRefusal("Declined by the user.");
    }
  };

  return {
    callTool: async ({ name, arguments: args }) => {
      if (!options.current().canOperate) {
        throw new McpAppHostRefusal("This connection cannot run app tools.");
      }
      const { environmentId, input } = target();
      const info = commandValue(
        await options.current().toolInfo({ environmentId, input: { ...input, name } }),
      );
      if (!info.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
      if (!info.readOnly) {
        await approve({
          kind: "tool",
          title: `Allow ${options.app.server} to run ${info.title ?? name}?`,
          message: JSON.stringify(args, null, 2),
          action: "Allow",
        });
      }
      return commandValue(
        await options.current().callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        }),
      );
    },
    readResource: async ({ uri }) => {
      if (!options.current().canRead) {
        throw new McpAppHostRefusal("This connection cannot read app resources.");
      }
      const { environmentId, input } = target();
      return commandValue(
        await options.current().readResource({ environmentId, input: { ...input, uri } }),
      );
    },
    sendMessage: async (text) => {
      const current = options.current();
      if (!current.canOperate) {
        throw new McpAppHostRefusal("This connection cannot send messages.");
      }
      const send = current.sendMessage;
      if (send === undefined) throw new McpAppHostRefusal("Messages are not available here.");
      await approve({
        kind: "message",
        title: `Send this message from ${options.app.server}?`,
        message: text,
        action: "Send",
      });
      await send(text);
    },
    updateModelContext: async (context) => {
      if (!options.current().canOperate) {
        throw new McpAppHostRefusal("This connection cannot update app context.");
      }
      const { environmentId, input } = target();
      commandValue(
        await options.current().updateModelContext({
          environmentId,
          input: {
            ...input,
            ...context,
            conversationThreadId: options.current().target.conversationThreadId,
          },
        }),
      );
    },
    downloadFile: async (files) => {
      if (!options.current().canRead) {
        throw new McpAppHostRefusal("This connection cannot read app resources.");
      }
      const names = files.map((file) => file.name).join(", ");
      await approve({
        kind: "download",
        title: `Save ${names} from ${options.app.server}?`,
        message: names,
        action: "Save",
      });
      for (const file of files) {
        let bytes: Uint8Array | undefined;
        let mimeType = file.mimeType ?? "application/octet-stream";
        if (file._tag === "embedded") {
          bytes = file.bytes;
        } else {
          const { environmentId, input } = target();
          const read = commandValue(
            await options.current().readResource({
              environmentId,
              input: { ...input, uri: file.uri },
            }),
          );
          const content = read.contents[0];
          bytes = mcpResourceBytes(content);
          if (Predicate.isObject(content) && typeof content.mimeType === "string") {
            mimeType = content.mimeType;
          }
        }
        if (bytes === undefined) throw new McpAppHostRefusal(`${file.name} has no contents.`);
        if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new McpAppHostRefusal(`${file.name} is too large to save.`);
        }
        await options.saveFile({ name: file.name, mimeType, bytes });
      }
    },
  } satisfies Pick<
    McpAppHostOptions,
    "callTool" | "readResource" | "sendMessage" | "updateModelContext" | "downloadFile"
  >;
}
