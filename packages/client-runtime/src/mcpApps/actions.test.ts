import { EnvironmentId, ThreadId, TurnItemId } from "@supacode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeMcpAppActions, type McpAppActionContext } from "./actions.ts";
import { McpAppHostRefusal } from "./host.ts";

const app = {
  attachmentId: "thread-app",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
};

function setup() {
  const commands = {
    toolInfo: vi.fn<McpAppActionContext["toolInfo"]>(async () =>
      AsyncResult.success({ callable: true, readOnly: false, title: "Update weather" }),
    ),
    callTool: vi.fn<McpAppActionContext["callTool"]>(async () =>
      AsyncResult.success({ content: [{ type: "text", text: "Done" }] }),
    ),
    readResource: vi.fn<McpAppActionContext["readResource"]>(async () =>
      AsyncResult.success({ contents: [{ text: "report", mimeType: "text/csv" }] }),
    ),
    updateModelContext: vi.fn<McpAppActionContext["updateModelContext"]>(async () =>
      AsyncResult.success(undefined),
    ),
  };
  const sendMessage = vi.fn(async (_text: string) => undefined);
  const confirm = vi.fn<Parameters<typeof makeMcpAppActions>[0]["confirm"]>(async () => true);
  const saveFile = vi.fn<Parameters<typeof makeMcpAppActions>[0]["saveFile"]>(
    async () => undefined,
  );
  let context: McpAppActionContext = {
    target: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-source"),
      itemId: TurnItemId.make("item-1"),
      conversationThreadId: ThreadId.make("thread-fork"),
    },
    canRead: true,
    canOperate: true,
    ...commands,
    sendMessage,
  };
  return {
    actions: makeMcpAppActions({ app, current: () => context, confirm, saveFile }),
    commands,
    confirm,
    saveFile,
    sendMessage,
    target: context.target,
    update: (patch: Partial<McpAppActionContext>) => {
      context = { ...context, ...patch };
    },
  };
}

describe("makeMcpAppActions", () => {
  it("checks current connection permissions before approval or RPC work", async () => {
    const { actions, commands, confirm, saveFile, sendMessage, update } = setup();
    await actions.readResource({ uri: "ui://weather/report" });
    commands.readResource.mockClear();
    update({ canRead: false, canOperate: false });

    await expect(actions.callTool({ name: "refresh", arguments: {} })).rejects.toThrow(
      "This connection cannot run app tools.",
    );
    await expect(actions.readResource({ uri: "ui://weather/report" })).rejects.toThrow(
      "This connection cannot read app resources.",
    );
    await expect(actions.sendMessage("Refresh weather")).rejects.toThrow(
      "This connection cannot send messages.",
    );
    await expect(actions.updateModelContext({ structuredContent: {} })).rejects.toThrow(
      "This connection cannot update app context.",
    );
    await expect(actions.downloadFile([])).rejects.toThrow(
      "This connection cannot read app resources.",
    );
    expect(commands.toolInfo).not.toHaveBeenCalled();
    expect(commands.callTool).not.toHaveBeenCalled();
    expect(commands.readResource).not.toHaveBeenCalled();
    expect(commands.updateModelContext).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects tools without app callability and lets read-only tools run without approval", async () => {
    const { actions, commands, confirm, target } = setup();
    commands.toolInfo.mockResolvedValueOnce(
      AsyncResult.success({ callable: false, readOnly: true }),
    );
    await expect(actions.callTool({ name: "private", arguments: {} })).rejects.toThrow(
      "This app cannot call that tool.",
    );
    expect(commands.callTool).not.toHaveBeenCalled();
    commands.toolInfo.mockResolvedValueOnce(
      AsyncResult.success({ callable: true, readOnly: true }),
    );
    const result = await actions.callTool({ name: "get_weather", arguments: { city: "Oslo" } });
    expect(result).toEqual({ content: [{ type: "text", text: "Done" }] });
    expect(confirm).not.toHaveBeenCalled();
    expect(commands.callTool).toHaveBeenCalledWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        itemId: target.itemId,
        name: "get_weather",
        arguments: { city: "Oslo" },
      },
    });
  });

  it("waits for explicit approval before a mutating tool can run", async () => {
    const { actions, commands, confirm } = setup();
    confirm.mockResolvedValueOnce(false);
    await expect(actions.callTool({ name: "refresh", arguments: {} })).rejects.toThrow(
      "Declined by the user.",
    );
    expect(commands.callTool).not.toHaveBeenCalled();

    await actions.callTool({ name: "refresh", arguments: { city: "Oslo" } });
    expect(confirm).toHaveBeenLastCalledWith({
      kind: "tool",
      title: "Allow weather to run Update weather?",
      message: '{\n  "city": "Oslo"\n}',
      action: "Allow",
    });
    expect(commands.callTool).toHaveBeenCalledTimes(1);
  });

  it("translates command failures into host refusals while preserving useful error messages", async () => {
    const { actions, commands } = setup();
    commands.toolInfo.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Stopped"))));
    await expect(actions.callTool({ name: "refresh", arguments: {} })).rejects.toThrow(
      new McpAppHostRefusal("Stopped"),
    );
    commands.callTool.mockResolvedValueOnce(AsyncResult.failure(Cause.die("unreadable")));
    await expect(actions.callTool({ name: "refresh", arguments: {} })).rejects.toThrow(
      new McpAppHostRefusal("Request failed."),
    );
    commands.readResource.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Gone"))));
    await expect(actions.readResource({ uri: "ui://weather/report" })).rejects.toThrow(
      new McpAppHostRefusal("Gone"),
    );
  });

  it("requires message approval and directs model context to the conversation fork", async () => {
    const { actions, commands, confirm, sendMessage, target, update } = setup();
    update({ sendMessage: undefined });
    await expect(actions.sendMessage("Refresh weather")).rejects.toThrow(
      "Messages are not available here.",
    );
    expect(confirm).not.toHaveBeenCalled();
    update({ sendMessage });
    confirm.mockResolvedValueOnce(false);
    await expect(actions.sendMessage("Refresh weather")).rejects.toThrow("Declined by the user.");
    expect(sendMessage).not.toHaveBeenCalled();
    await actions.sendMessage("Refresh weather");
    expect(sendMessage).toHaveBeenCalledWith("Refresh weather");
    await actions.updateModelContext({ structuredContent: { city: "Oslo" } });
    expect(commands.updateModelContext).toHaveBeenCalledWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        itemId: target.itemId,
        conversationThreadId: target.conversationThreadId,
        structuredContent: { city: "Oslo" },
      },
    });
  });

  it("approves downloads before reading links and respects returned MIME types", async () => {
    const { actions, commands, confirm, saveFile } = setup();
    const file = { _tag: "link" as const, name: "report.csv", uri: "ui://weather/report" };
    confirm.mockResolvedValueOnce(false);
    await expect(actions.downloadFile([file])).rejects.toThrow("Declined by the user.");
    expect(commands.readResource).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();

    await actions.downloadFile([file]);
    expect(saveFile).toHaveBeenCalledWith({
      name: "report.csv",
      mimeType: "text/csv",
      bytes: new TextEncoder().encode("report"),
    });
    expect(confirm).toHaveBeenLastCalledWith({
      kind: "download",
      title: "Save report.csv from weather?",
      message: "report.csv",
      action: "Save",
    });
  });

  it("rejects empty resource content and files above the download cap", async () => {
    const { actions, commands, saveFile } = setup();
    commands.readResource.mockResolvedValueOnce(AsyncResult.success({ contents: [] }));
    await expect(
      actions.downloadFile([{ _tag: "link", name: "report.csv", uri: "ui://weather/report" }]),
    ).rejects.toThrow("report.csv has no contents.");
    await expect(
      actions.downloadFile([
        {
          _tag: "embedded",
          name: "large.csv",
          mimeType: "text/csv",
          bytes: new Uint8Array(25 * 1024 * 1024 + 1),
        },
      ]),
    ).rejects.toThrow("large.csv is too large to save.");
    expect(saveFile).not.toHaveBeenCalled();
  });
});
