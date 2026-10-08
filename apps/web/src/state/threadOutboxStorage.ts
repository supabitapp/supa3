import type { BrowserThreadOutboxStorage, ThreadOutboxEntry } from "./threadOutboxDelivery";
import * as Schema from "effect/Schema";
import { CommandId } from "@supacode/contracts";

import { OutboxTurn, StoredOutboxEntry } from "./threadOutboxSchema";
import { randomUUID } from "../lib/utils";

const DATABASE_NAME = "supacode-thread-outbox";
const LEASE_MS = 60_000;
const decode = Schema.decodeUnknownSync(StoredOutboxEntry);
const decodeBindingCommand = Schema.decodeUnknownSync(Schema.Struct({ commandId: CommandId }));

export function storedThreadOutboxEntry(entry: ThreadOutboxEntry<OutboxTurn>) {
  return { schemaVersion: 1 as const, ...entry };
}
let database: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
function storageChannel() {
  if (typeof BroadcastChannel !== "undefined") channel ??= new BroadcastChannel(DATABASE_NAME);
  return channel;
}

export function notifyThreadOutboxStorage() {
  storageChannel()?.postMessage("changed");
}

export function subscribeThreadOutboxStorage(listener: () => void) {
  const source = storageChannel();
  source?.addEventListener("message", listener);
  return () => source?.removeEventListener("message", listener);
}

export function openThreadOutboxDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 3);
    request.onupgradeneeded = () => {
      for (const [name, keyPath] of [
        ["messages", "id"],
        ["locks", "scope"],
        ["creations", "id"],
        ["creationBindings", "id"],
      ] as const) {
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath });
      }
    };
    request.onsuccess = () => {
      request.result.addEventListener("versionchange", () => {
        request.result.close();
        database = null;
      });
      resolve(request.result);
    };
    request.addEventListener("error", () => {
      database = null;
      reject(request.error);
    });
    request.onblocked = () => {
      database = null;
      reject(new Error("Close other Supacode tabs to open message storage."));
    };
  });
  return database;
}

async function transaction<A>(
  storeName: string | string[],
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, complete: (result: A) => void) => void,
): Promise<A> {
  const db = await openThreadOutboxDatabase();
  return new Promise<A>((resolve, reject) => {
    const names = typeof storeName === "string" ? [storeName] : storeName;
    const tx = db.transaction(names, mode);
    let result: A;
    tx.oncomplete = () => resolve(result);
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("Message storage transaction was aborted.")),
    );
    operation(tx.objectStore(names[0]!), (value) => {
      result = value;
    });
  });
}

const Lease = Schema.Struct({
  scope: Schema.String,
  owner: Schema.String,
  expiresAt: Schema.Number,
});
const decodeLease = Schema.decodeUnknownSync(Lease);

export function storedThreadCreationBinding(payload: OutboxTurn) {
  const creation = payload.input.bootstrap?.createThread;
  if (!payload.draftId || !creation) return null;
  return {
    id: payload.draftId,
    commandId: payload.input.commandId,
    environmentId: payload.environmentId,
    projectId: creation.projectId,
    threadId: payload.input.threadId,
  };
}

/** IndexedDB also works on HTTP LAN origins where Web Locks are unavailable. */
export const browserThreadOutboxStorage: BrowserThreadOutboxStorage<OutboxTurn> = {
  load: async () => {
    const values = await transaction<unknown[]>("messages", "readonly", (store, complete) => {
      const request = store.getAll();
      request.onsuccess = () => complete(request.result);
    });
    return values.map((value) => {
      const { schemaVersion: _, ...entry } = decode(value);
      return entry;
    });
  },
  write: async (entry) => {
    const changed = await transaction<boolean>(
      ["messages", "creationBindings"],
      "readwrite",
      (store, complete) => {
        const request = store.get(entry.id);
        request.onsuccess = () => {
          if (request.result === undefined) {
            complete(false);
            return;
          }
          const previous = decode(request.result);
          store.put(storedThreadOutboxEntry(entry));
          const updated = storedThreadCreationBinding(entry.payload);
          const previousDraftId = previous.payload.draftId;
          if (!previousDraftId || !updated) {
            complete(true);
            return;
          }
          const bindings = store.transaction.objectStore("creationBindings");
          const binding = bindings.get(previousDraftId);
          binding.onsuccess = () => {
            if (
              binding.result !== undefined &&
              decodeBindingCommand(binding.result).commandId === previous.payload.input.commandId
            ) {
              if (previousDraftId !== updated.id) bindings.delete(previousDraftId);
              bindings.put(updated);
            }
            complete(true);
          };
        };
      },
    );
    if (changed) storageChannel()?.postMessage("changed");
    return changed;
  },
  writeMany: async (entries) => {
    await transaction<void>("messages", "readwrite", (store, complete) => {
      for (const entry of entries) store.add(storedThreadOutboxEntry(entry));
      complete(undefined);
    });
    storageChannel()?.postMessage("changed");
  },
  remove: async (id) => {
    await transaction<void>(["messages", "creationBindings"], "readwrite", (messages, complete) => {
      const request = messages.get(id);
      request.onsuccess = () => {
        if (request.result === undefined) {
          complete(undefined);
          return;
        }
        const entry = decode(request.result);
        const draftId = entry.payload.draftId;
        messages.delete(id);
        if (entry.status === "delivered" || !draftId) {
          complete(undefined);
          return;
        }
        const bindings = messages.transaction.objectStore("creationBindings");
        const binding = bindings.get(draftId);
        binding.onsuccess = () => {
          if (
            binding.result !== undefined &&
            decodeBindingCommand(binding.result).commandId === entry.payload.input.commandId
          )
            bindings.delete(draftId);
          complete(undefined);
        };
      };
    });
    storageChannel()?.postMessage("changed");
  },
  withLock: async (scope, action) => {
    const owner = randomUUID();
    const claimed = await transaction<boolean>("locks", "readwrite", (store, complete) => {
      const request = store.get(scope);
      request.onsuccess = () => {
        const existing = request.result === undefined ? null : decodeLease(request.result);
        if (existing !== null && existing.expiresAt > Date.now()) {
          complete(false);
          return;
        }
        store.put({ scope, owner, expiresAt: Date.now() + LEASE_MS });
        complete(true);
      };
    });
    if (!claimed) return null;
    const renew = () =>
      transaction<void>("locks", "readwrite", (store, complete) => {
        const request = store.get(scope);
        request.onsuccess = () => {
          if (request.result !== undefined && decodeLease(request.result).owner === owner) {
            store.put({ scope, owner, expiresAt: Date.now() + LEASE_MS });
          }
          complete(undefined);
        };
      });
    const timer = setInterval(() => {
      void renew().catch(console.error);
    }, LEASE_MS / 3);
    try {
      return await action();
    } finally {
      clearInterval(timer);
      await transaction<void>("locks", "readwrite", (store, complete) => {
        const request = store.get(scope);
        request.onsuccess = () => {
          if (request.result !== undefined && decodeLease(request.result).owner === owner)
            store.delete(scope);
          complete(undefined);
        };
      });
    }
  },
};
