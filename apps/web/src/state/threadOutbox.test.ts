import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  PlanId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@supacode/contracts";
import type { ThreadOutboxEntry } from "./threadOutboxDelivery";
import { DraftId } from "../composerDraftStore";
import type { OutboxTurn } from "./threadOutboxSchema";

const harness = vi.hoisted(() => ({
  records: new Map<string, ThreadOutboxEntry<OutboxTurn>>(),
  run: vi.fn(),
  verify: vi.fn(),
  marked: vi.fn(),
  finalized: vi.fn(),
  supportsUploads: false,
  online: false,
  existingThread: false,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  return {
    appAtomRegistry: {
      set: registry.set.bind(registry),
      subscribe: registry.subscribe.bind(registry),
      get: (...args: Parameters<typeof registry.get>) => {
        const atom: unknown = args[0];
        if (typeof atom !== "string") return registry.get(...args);
        if (atom === "presentation")
          return { connection: { phase: harness.online ? "connected" : "offline" } };
        if (atom === "shell") return { status: harness.online ? "live" : "cached" };
        if (atom === "snapshot")
          return {
            threads: harness.existingThread
              ? [
                  {
                    id: "thread",
                    branch: "old",
                    runtimeMode: "approval-required",
                    interactionMode: "plan",
                  },
                ]
              : [],
          };
        return new Map([
          [
            "environment",
            {
              environment: {
                capabilities: {
                  attachmentUploads: harness.supportsUploads,
                  inlineMessageContext: true,
                  fileAttachments: { maxUploadBytes: 1_000 },
                },
              },
            },
          ],
        ]);
      },
    },
  };
});
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationAtom: () => "presentation" },
}));
vi.mock("./shell", () => ({ environmentShell: { stateValueAtom: () => "shell" } }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("./threadCommands", () => ({
  directThreadEnvironment: {
    startTurn: { label: "send" },
    updateMetadata: { label: "branch" },
    setRuntimeMode: { label: "runtime" },
    setInteractionMode: { label: "interaction" },
    snapshotAtom: () => "snapshot",
  },
}));
vi.mock("./attachments", () => ({
  attachmentEnvironment: { createUploadUrl: { label: "upload" }, remove: { label: "remove" } },
}));
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: { label: "verify" } } }));
vi.mock("./session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://environment.example" }),
}));
vi.mock("../lib/utils", () => ({ randomUUID: () => "generated-command" }));
vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (id: string) => id },
  markPromotedDraftThreadByRef: harness.marked,
  finalizePromotedDraftThreadByRef: harness.finalized,
}));
vi.mock("../components/ChatView.logic", () => ({
  readFileAsDataUrl: async (file: File) => `data:${file.type};base64,${btoa(await file.text())}`,
}));
vi.mock("@supacode/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supacode/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => harness.run(...args),
}));
vi.mock("@supacode/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supacode/client-runtime/state/attachments")>()),
  verifyPersistedAttachmentUpload: (...args: unknown[]) => harness.verify(...args),
}));
vi.mock("./threadOutboxStorage", () => ({
  browserThreadOutboxStorage: {
    load: async () => [...harness.records.values()],
    write: async (entry: ThreadOutboxEntry<OutboxTurn>) => {
      if (!harness.records.has(entry.id)) return false;
      harness.records.set(entry.id, entry);
      return true;
    },
    writeMany: async (entries: ReadonlyArray<ThreadOutboxEntry<OutboxTurn>>) => {
      for (const entry of entries) harness.records.set(entry.id, entry);
    },
    remove: async (id: string) => {
      harness.records.delete(id);
    },
    withLock: async (_scope: string, action: () => Promise<unknown>) => action(),
  },
}));

function target() {
  return {
    environmentId: EnvironmentId.make("environment"),
    input: {
      commandId: CommandId.make("stable-command"),
      threadId: ThreadId.make("thread"),
      message: {
        messageId: MessageId.make("message"),
        role: "user" as const,
        text: "Saved prompt",
        attachments: [],
      },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  harness.records.clear();
  harness.online = false;
  harness.supportsUploads = false;
  harness.existingThread = false;
  harness.run.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  harness.verify.mockResolvedValue({ status: "verified" });
});

describe("web thread outbox delivery", () => {
  it("retries compaction with the same IDs and queues the saved prompt only after acknowledgement", async () => {
    const { enqueueThreadOutboxTurn, webThreadOutbox } = await import("./threadOutbox");
    await enqueueThreadOutboxTurn({ ...target(), compactBeforeSend: true });
    harness.online = true;
    harness.run.mockResolvedValueOnce(AsyncResult.fail({ _tag: "RpcClientError" }));
    await webThreadOutbox.drain();
    expect(harness.run).toHaveBeenCalledTimes(1);
    const compact = harness.run.mock.calls[0]![2];
    expect(compact.input).toMatchObject({
      commandId: "stable-command:compact",
      message: { messageId: "message:compact", text: "/compact", attachments: [] },
      dispatchMode: "queue",
    });
    const saved = harness.records.get("message")!;
    expect(saved.payload.input.message.text).toBe("Saved prompt");
    expect(saved.payload.compactAccepted).toBeUndefined();
    harness.records.set("message", { ...saved, retryAt: 0 });
    await webThreadOutbox.drain();
    expect(harness.run.mock.calls[1]![2]).toEqual(compact);
    expect(harness.run.mock.calls[2]![2].input).toMatchObject({
      commandId: "stable-command",
      message: { messageId: "message", text: "Saved prompt" },
      dispatchMode: "queue",
    });
    expect(harness.records.size).toBe(0);
  });

  it("does not compact again when a failed prompt is retried after compaction was accepted", async () => {
    const { enqueueThreadOutboxTurn, replaceThreadOutboxTurn, webThreadOutbox } =
      await import("./threadOutbox");
    await enqueueThreadOutboxTurn({ ...target(), compactBeforeSend: true });
    harness.online = true;
    harness.run
      .mockResolvedValueOnce(AsyncResult.success({ sequence: 1 }))
      .mockImplementationOnce(async () => {
        expect(harness.records.get("message")?.payload.compactAccepted).toBe(true);
        return AsyncResult.fail({
          _tag: "OrchestrationDispatchCommandError",
          message: "Prompt dispatch was rejected.",
        });
      });

    await webThreadOutbox.drain();

    expect(harness.run).toHaveBeenCalledTimes(2);
    const failed = webThreadOutbox.getSnapshot()[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.payload.compactBeforeSend).toBe(true);
    expect(failed.payload.compactAccepted).toBe(true);
    expect(harness.run.mock.calls[0]![2].input.message.text).toBe("/compact");
    expect(harness.run.mock.calls[1]![2].input.message.text).toBe("Saved prompt");

    await replaceThreadOutboxTurn(failed, failed.payload);
    await webThreadOutbox.drain();

    expect(harness.run).toHaveBeenCalledTimes(3);
    expect(harness.run.mock.calls[2]![2].input).toMatchObject({
      commandId: "generated-command",
      message: { messageId: "message", text: "Saved prompt" },
      dispatchMode: "queue",
    });
    expect(harness.run.mock.calls[2]![2].input.message.text).not.toBe("/compact");
    expect(harness.records.size).toBe(0);
  });

  it.each([
    { instanceId: "different-provider", text: "Edited prompt" },
    { instanceId: "codex", text: "/compact" },
  ])("drops automatic compaction when an edit changes its target: %j", async (edit) => {
    const { enqueueThreadOutboxTurn, webThreadOutbox, replaceThreadOutboxTurn } =
      await import("./threadOutbox");
    await enqueueThreadOutboxTurn({ ...target(), compactBeforeSend: true });
    await webThreadOutbox.pause("message", true);
    const entry = webThreadOutbox.getSnapshot()[0]!;
    await replaceThreadOutboxTurn(entry, {
      ...entry.payload,
      compactAccepted: true,
      input: {
        ...entry.payload.input,
        modelSelection: {
          instanceId: ProviderInstanceId.make(edit.instanceId),
          model: "test-model",
        },
        message: { ...entry.payload.input.message, text: edit.text },
      },
    });
    expect(webThreadOutbox.getSnapshot()[0]?.payload.compactAccepted).toBeUndefined();
    harness.online = true;
    await webThreadOutbox.drain();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.run.mock.calls[0]![2].input.message.text).toBe(edit.text);
    expect(harness.records.size).toBe(0);
  });

  it("persists an edited message with a new command ID before delivering it", async () => {
    const { enqueueThreadOutboxTurn, webThreadOutbox, replaceThreadOutboxTurn } =
      await import("./threadOutbox");
    await enqueueThreadOutboxTurn(target());
    await webThreadOutbox.pause("message", true);
    const entry = webThreadOutbox.getSnapshot()[0]!;
    await replaceThreadOutboxTurn(entry, {
      ...entry.payload,
      input: {
        ...entry.payload.input,
        message: { ...entry.payload.input.message, text: "Edited in the composer" },
      },
    });
    expect(harness.records.get("message")?.payload.input).toMatchObject({
      commandId: "generated-command",
      message: { messageId: "message", text: "Edited in the composer" },
    });
    expect(harness.records.get("message")?.paused).toBe(false);
    harness.online = true;
    await webThreadOutbox.drain();
    expect(harness.run).toHaveBeenLastCalledWith(
      expect.anything(),
      { label: "send" },
      expect.objectContaining({
        input: expect.objectContaining({
          commandId: "generated-command",
          message: expect.objectContaining({
            messageId: "message",
            text: "Edited in the composer",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("applies saved thread settings before delivering a plan follow-up", async () => {
    const { enqueueThreadOutboxTurn, webThreadOutbox } = await import("./threadOutbox");
    const original = target();
    await enqueueThreadOutboxTurn({
      ...original,
      branch: "main",
      input: {
        ...original.input,
        sourceProposedPlan: { threadId: ThreadId.make("thread"), planId: PlanId.make("plan") },
      },
    });
    harness.existingThread = true;
    harness.online = true;
    await webThreadOutbox.drain();
    expect(harness.run.mock.calls.map((call) => call[1].label)).toEqual([
      "branch",
      "runtime",
      "interaction",
      "send",
    ]);
    expect(harness.run).toHaveBeenLastCalledWith(
      expect.anything(),
      { label: "send" },
      expect.objectContaining({
        input: expect.objectContaining({
          commandId: "stable-command",
          runtimeMode: "full-access",
          interactionMode: "default",
          sourceProposedPlan: { threadId: "thread", planId: "plan" },
        }),
      }),
      expect.anything(),
    );
  });

  it("sends a restored offline message with its original command and message IDs", async () => {
    const { enqueueThreadOutboxTurn, webThreadOutbox } = await import("./threadOutbox");
    await enqueueThreadOutboxTurn(target());
    await webThreadOutbox.drain();
    expect(harness.run).not.toHaveBeenCalled();
    vi.resetModules();
    const recovered = (await import("./threadOutbox")).webThreadOutbox;
    harness.online = true;
    await recovered.drain();
    expect(harness.run).toHaveBeenCalledWith(
      expect.anything(),
      { label: "send" },
      expect.objectContaining({
        input: expect.objectContaining({
          commandId: "stable-command",
          message: expect.objectContaining({ messageId: "message", text: "Saved prompt" }),
        }),
      }),
      expect.anything(),
    );
    expect(harness.records.size).toBe(0);
  });

  it("retains local image bytes across reload and prepares the legacy upload only at delivery", async () => {
    const { enqueueThreadOutboxTurn } = await import("./threadOutbox");
    await enqueueThreadOutboxTurn({
      ...target(),
      localAttachments: [
        {
          id: "local-image",
          type: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 5,
          bytes: new Blob(["image"], { type: "image/png" }),
        },
      ],
    });
    vi.resetModules();
    harness.online = true;
    await (await import("./threadOutbox")).webThreadOutbox.drain();
    expect(harness.run).toHaveBeenCalledWith(
      expect.anything(),
      { label: "send" },
      expect.objectContaining({
        input: expect.objectContaining({
          message: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                id: "local-image",
                dataUrl: "data:image/png;base64,aW1hZ2U=",
              }),
            ],
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("persists an uploaded file reference before dispatch and reuses it after a transport failure", async () => {
    harness.supportsUploads = true;
    harness.online = true;
    const transfer = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", transfer);
    harness.run.mockImplementation(async (_registry: unknown, operation: { label: string }) =>
      operation.label === "upload"
        ? AsyncResult.success({ attachmentId: "uploaded-file", relativeUrl: "/signed-upload" })
        : AsyncResult.fail({ _tag: "RpcClientError" }),
    );
    const { enqueueThreadOutboxTurn, webThreadOutbox } = await import("./threadOutbox");
    await enqueueThreadOutboxTurn({
      ...target(),
      localAttachments: [
        {
          id: "local-file",
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          bytes: new Blob(["notes"]),
        },
      ],
    });
    await webThreadOutbox.drain();
    const saved = harness.records.get("message");
    expect(saved?.payload.localAttachments[0]?.uploaded?.id).toBe("uploaded-file");
    expect(transfer).toHaveBeenCalledWith(
      "https://environment.example/signed-upload",
      expect.objectContaining({ method: "POST", body: expect.any(Blob) }),
    );
    vi.resetModules();
    harness.run.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
    // Reconnect after the retry backoff without using timers or polling.
    if (!saved) throw new Error("Expected the retained pending message");
    harness.records.set("message", { ...saved, retryAt: 0 });
    await (await import("./threadOutbox")).webThreadOutbox.drain();
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(harness.verify).toHaveBeenCalled();
    expect(harness.run).toHaveBeenLastCalledWith(
      expect.anything(),
      { label: "send" },
      expect.objectContaining({
        input: expect.objectContaining({
          commandId: "stable-command",
          message: expect.objectContaining({
            attachments: [expect.objectContaining({ id: "uploaded-file", type: "file" })],
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("retains an oversized attachment as a failed pending message", async () => {
    harness.supportsUploads = true;
    harness.online = true;
    const { enqueueThreadOutboxTurn, webThreadOutbox } = await import("./threadOutbox");
    await enqueueThreadOutboxTurn({
      ...target(),
      localAttachments: [
        {
          id: "file",
          type: "file",
          name: "large.txt",
          mimeType: "text/plain",
          sizeBytes: 1_001,
          bytes: new Blob(["content"]),
        },
      ],
    });
    await webThreadOutbox.drain();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.records.get("message")?.status).toBe("failed");
    expect(harness.records.get("message")?.payload.localAttachments[0]?.bytes).toBeInstanceOf(Blob);
  });

  it("clears only the removed environment's pending messages", async () => {
    const { enqueueThreadOutboxTurn, clearThreadOutboxEnvironment } =
      await import("./threadOutbox");
    await enqueueThreadOutboxTurn(target());
    const other = target();
    await enqueueThreadOutboxTurn({
      ...other,
      environmentId: EnvironmentId.make("other"),
      input: {
        ...other.input,
        message: { ...other.input.message, messageId: MessageId.make("other-message") },
      },
    });
    await clearThreadOutboxEnvironment(EnvironmentId.make("environment"));
    expect([...harness.records.keys()]).toEqual(["other-message"]);
  });

  it("keeps the foreground draft until its server route can take over", async () => {
    const { enqueueThreadOutboxTurn, webThreadOutbox } = await import("./threadOutbox");
    const original = target();
    await enqueueThreadOutboxTurn({
      ...original,
      draftId: DraftId.make("draft"),
      input: {
        ...original.input,
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project"),
            title: "Task",
            modelSelection: original.input.modelSelection,
            runtimeMode: original.input.runtimeMode,
            interactionMode: original.input.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: "2026-10-06T00:00:00Z",
          },
        },
      },
    });
    harness.online = true;
    await webThreadOutbox.drain();
    expect(harness.marked).toHaveBeenCalled();
    expect(harness.finalized).not.toHaveBeenCalled();
  });
});
