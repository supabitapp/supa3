import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, EnvironmentId, ThreadId } from "@supacode/contracts";
import { creation } from "./threadCreationTestFixtures";

import type { ThreadCreation } from "./threadCreationStorage";

function destination(entry: ThreadCreation, environmentId = "destination") {
  return { ...entry.payload, environmentId: EnvironmentId.make(environmentId) };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("automatic thread creation storage", () => {
  it("moves the recovery lookup to the replacement IDs during a rejected creation retry", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const { browserThreadOutboxStorage } = await import("./threadOutboxStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    await threadCreationStorage.bind(entry, destination(entry));
    const original = (await browserThreadOutboxStorage.load())[0]!;
    await browserThreadOutboxStorage.write({ ...original, status: "failed" });
    const replacement = {
      ...original,
      payload: {
        ...original.payload,
        input: {
          ...original.payload.input,
          commandId: CommandId.make("retry-command"),
          threadId: ThreadId.make("retry-thread"),
        },
      },
    };
    await browserThreadOutboxStorage.write(replacement);
    expect(await threadCreationStorage.loadBinding(entry.id)).toMatchObject({
      commandId: "retry-command",
      threadId: "retry-thread",
    });
  });
  it("retains the immutable destination lookup after the creation and outbox rows are consumed", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const { browserThreadOutboxStorage } = await import("./threadOutboxStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    await threadCreationStorage.bind(entry, destination(entry));
    await threadCreationStorage.remove((await threadCreationStorage.load())[0]!);
    await browserThreadOutboxStorage.write({
      ...(await browserThreadOutboxStorage.load())[0]!,
      status: "delivered",
    });
    await browserThreadOutboxStorage.remove(entry.payload.input.message.messageId);
    expect(await threadCreationStorage.load()).toEqual([]);
    expect(await threadCreationStorage.loadBinding(entry.id)).toEqual({
      id: entry.id,
      commandId: entry.payload.input.commandId,
      environmentId: "destination",
      projectId: "source-project",
      threadId: entry.payload.input.threadId,
    });
  });

  it("invalidates an undelivered binding atomically when its outbox message is cancelled", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const { browserThreadOutboxStorage } = await import("./threadOutboxStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    await threadCreationStorage.bind(entry, destination(entry));
    await browserThreadOutboxStorage.remove(entry.payload.input.message.messageId);
    expect((await threadCreationStorage.load())[0]?.status).toBe("bound");
    expect(await threadCreationStorage.loadBinding(entry.id)).toBeNull();
    expect(await browserThreadOutboxStorage.load()).toEqual([]);
  });
  it("does not let old cleanup delete a newer cancellation sharing the same draft ID", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const old = creation();
    await threadCreationStorage.enqueue(old);
    await threadCreationStorage.cancel(old);
    const oldCancelled = (await threadCreationStorage.load())[0]!;
    await threadCreationStorage.remove(oldCancelled);
    const current = {
      ...creation(),
      payload: {
        ...old.payload,
        input: { ...old.payload.input, commandId: CommandId.make("new-command") },
      },
    };
    await threadCreationStorage.enqueue(current);
    await threadCreationStorage.cancel(current);
    await threadCreationStorage.remove(oldCancelled);
    expect((await threadCreationStorage.load())[0]?.payload.input.commandId).toBe("new-command");
  });
  it("rejects an older resolver after the draft is edited and submitted again", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const old = creation();
    await threadCreationStorage.enqueue(old);
    await threadCreationStorage.cancel(old);
    const cancelled = (await threadCreationStorage.load())[0]!;
    await threadCreationStorage.remove(cancelled);
    const current = {
      ...creation(),
      payload: {
        ...old.payload,
        input: { ...old.payload.input, commandId: CommandId.make("new-command") },
      },
    };
    await threadCreationStorage.enqueue(current);
    expect(await threadCreationStorage.bind(old, destination(old))).toBe(false);
    expect(await threadCreationStorage.cancel(old)).toBe(false);
    expect(await threadCreationStorage.bind(current, destination(current))).toBe(true);
  });
  it("lets exactly one tab bind and hands off the original execution identities", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const { browserThreadOutboxStorage } = await import("./threadOutboxStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    const results = await Promise.all([
      threadCreationStorage.bind(entry, destination(entry, "first")),
      threadCreationStorage.bind(entry, destination(entry, "second")),
    ]);
    expect(results).toEqual([true, false]);
    const stored = await browserThreadOutboxStorage.load();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload.environmentId).toBe("first");
    expect(stored[0]?.payload.input.commandId).toBe(entry.payload.input.commandId);
    expect(stored[0]?.payload.input.threadId).toBe(entry.payload.input.threadId);
    expect(stored[0]?.attempted).toBe(false);
    expect((await threadCreationStorage.load())[0]?.status).toBe("bound");
  });

  it("cancellation prevents a stale resolver from creating a delivery entry", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const { browserThreadOutboxStorage } = await import("./threadOutboxStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    expect(await threadCreationStorage.cancel(entry)).toBe(true);
    expect(await threadCreationStorage.bind(entry, destination(entry))).toBe(false);
    expect(await browserThreadOutboxStorage.load()).toEqual([]);
    expect((await threadCreationStorage.load())[0]).toMatchObject({
      status: "cancelled",
      prompt: "Saved prompt",
    });
  });

  it("a bind that wins the race cannot be cancelled or redirected", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    expect(await threadCreationStorage.bind(entry, destination(entry))).toBe(true);
    expect(await threadCreationStorage.cancel(entry)).toBe(false);
    expect(await threadCreationStorage.bind(entry, destination(entry, "other"), true)).toBe(false);
  });

  it("paces automatic starts on the same machine and allows a manual override", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const entries = [creation("one"), creation("two"), creation("three")];
    for (const entry of entries) await threadCreationStorage.enqueue(entry);
    expect(await threadCreationStorage.bind(entries[0]!, destination(entries[0]!))).toBe(true);
    expect(await threadCreationStorage.bind(entries[1]!, destination(entries[1]!))).toBe(false);
    expect(await threadCreationStorage.bind(entries[2]!, destination(entries[2]!), true)).toBe(
      true,
    );
    vi.setSystemTime(new Date("2026-10-08T00:00:05Z"));
    expect(await threadCreationStorage.bind(entries[1]!, destination(entries[1]!))).toBe(true);
  });

  it("rolls binding back if inserting the outbox message fails", async () => {
    const { threadCreationStorage } = await import("./threadCreationStorage");
    const { browserThreadOutboxStorage } = await import("./threadOutboxStorage");
    const entry = creation();
    await threadCreationStorage.enqueue(entry);
    await browserThreadOutboxStorage.writeMany([
      {
        id: entry.payload.input.message.messageId,
        scope: "source:thread",
        createdAt: "2026-10-08T00:00:00Z",
        payload: entry.payload,
        position: 0,
        status: "pending",
        attempted: false,
        attempts: 0,
        retryAt: 0,
        error: null,
        paused: false,
        pauseUntil: 0,
      },
    ]);
    await expect(threadCreationStorage.bind(entry, destination(entry))).rejects.toBeDefined();
    expect((await threadCreationStorage.load())[0]?.status).toBe("waiting");
    expect((await browserThreadOutboxStorage.load())[0]?.payload.environmentId).toBe("source");
  });

  it("upgrades existing message storage without removing its queued messages", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("supacode-thread-outbox", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("messages", { keyPath: "id" }).add({ id: "legacy" });
        request.result.createObjectStore("locks", { keyPath: "scope" });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.addEventListener("error", () => reject(request.error));
    });
    const { openThreadOutboxDatabase } = await import("./threadOutboxStorage");
    const db = await openThreadOutboxDatabase();
    const legacy = await new Promise<unknown>((resolve) => {
      const request = db.transaction("messages").objectStore("messages").get("legacy");
      request.onsuccess = () => resolve(request.result);
    });
    expect(legacy).toEqual({ id: "legacy" });
    expect(db.objectStoreNames.contains("creations")).toBe(true);
  });
});
