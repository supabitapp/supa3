import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@supacode/contracts";

import {
  OutboxBootstrap,
  OutboxCreateThread,
  OutboxTurn,
  OutboxTurnInput,
} from "./threadOutboxSchema";
import {
  notifyThreadOutboxStorage,
  openThreadOutboxDatabase,
  storedThreadOutboxEntry,
  storedThreadCreationBinding,
} from "./threadOutboxStorage";
import { createPendingThreadOutboxEntry } from "./threadOutboxDelivery";
import { scopedThreadKey, scopeThreadRef } from "@supacode/client-runtime/environment";

const CreationPayload = Schema.Struct({
  ...OutboxTurn.fields,
  draftId: Schema.String,
  input: Schema.Struct({
    ...OutboxTurnInput.fields,
    modelSelection: ModelSelection,
    bootstrap: Schema.Struct({ ...OutboxBootstrap.fields, createThread: OutboxCreateThread }),
  }),
});

const ThreadCreation = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  status: Schema.Literals(["waiting", "bound", "cancelled"]),
  routingKey: Schema.String,
  logicalProjectKey: Schema.String,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  driver: ProviderDriverKind,
  prompt: Schema.String,
  payload: CreationPayload,
});

export type ThreadCreation = typeof ThreadCreation.Type;
const decodeCreation = Schema.decodeUnknownSync(ThreadCreation);

const ThreadCreationBinding = Schema.Struct({
  id: Schema.String,
  commandId: CommandId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type ThreadCreationBinding = typeof ThreadCreationBinding.Type;
const decodeBinding = Schema.decodeUnknownSync(ThreadCreationBinding);

async function transaction<A>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction, complete: (value: A) => void) => void,
) {
  const db = await openThreadOutboxDatabase();
  return new Promise<A>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: A;
    tx.oncomplete = () => resolve(value);
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("Task storage was aborted.")));
    tx.addEventListener("error", () => reject(tx.error));
    try {
      action(tx, (result) => {
        value = result;
      });
    } catch (cause) {
      tx.abort();
      reject(cause);
    }
  });
}

function readCreation(
  store: IDBObjectStore,
  id: string,
  action: (entry: ThreadCreation | null) => void,
) {
  const request = store.get(id);
  request.onsuccess = () => {
    try {
      action(request.result === undefined ? null : decodeCreation(request.result));
    } catch {
      store.transaction.abort();
    }
  };
}

async function readState(id: string) {
  const rows = await transaction<readonly [unknown, unknown]>(
    ["creations", "creationBindings"],
    "readonly",
    (tx, complete) => {
      let creation: unknown;
      let binding: unknown;
      let remaining = 2;
      const finish = () => {
        if (--remaining === 0) complete([creation, binding]);
      };
      const creationRequest = tx.objectStore("creations").get(id);
      creationRequest.onsuccess = () => {
        creation = creationRequest.result;
        finish();
      };
      const bindingRequest = tx.objectStore("creationBindings").get(id);
      bindingRequest.onsuccess = () => {
        binding = bindingRequest.result;
        finish();
      };
    },
  );
  return {
    creation: rows[0] === undefined ? null : decodeCreation(rows[0]),
    binding: rows[1] === undefined ? null : decodeBinding(rows[1]),
  };
}

export const threadCreationStorage = {
  readState,
  loadBinding: async (id: string) => (await readState(id)).binding,
  load: async () => {
    const rows = await transaction<unknown[]>(["creations"], "readonly", (tx, complete) => {
      const request = tx.objectStore("creations").getAll();
      request.onsuccess = () => complete(request.result);
    });
    return rows.map((row) => decodeCreation(row));
  },
  enqueue: async (entry: ThreadCreation) => {
    const decoded = decodeCreation(entry);
    await transaction<void>(["creations"], "readwrite", (tx, complete) => {
      tx.objectStore("creations").add(decoded);
      complete(undefined);
    });
    notifyThreadOutboxStorage();
  },
  cancel: async (entry: ThreadCreation) => {
    const cancelled = await transaction<boolean>(["creations"], "readwrite", (tx, complete) => {
      const store = tx.objectStore("creations");
      readCreation(store, entry.id, (live) => {
        if (
          !live ||
          live.status !== "waiting" ||
          live.revision !== entry.revision ||
          live.payload.input.commandId !== entry.payload.input.commandId
        ) {
          complete(false);
          return;
        }
        store.put({ ...live, status: "cancelled", revision: live.revision + 1 });
        complete(true);
      });
    });
    if (cancelled) notifyThreadOutboxStorage();
    return cancelled;
  },
  remove: async (entry: ThreadCreation) => {
    await transaction<void>(["creations"], "readwrite", (tx, complete) => {
      const store = tx.objectStore("creations");
      readCreation(store, entry.id, (live) => {
        if (
          live?.revision === entry.revision &&
          live.status === entry.status &&
          live.status !== "waiting" &&
          live.payload.input.commandId === entry.payload.input.commandId
        )
          store.delete(entry.id);
        complete(undefined);
      });
    });
    notifyThreadOutboxStorage();
  },
  bind: async (entry: ThreadCreation, payload: ThreadCreation["payload"], manual = false) => {
    const binding = storedThreadCreationBinding(payload);
    if (!binding) throw new Error("A queued creation needs a draft and project.");
    const now = Date.now();
    const bound = await transaction<boolean>(
      ["creations", "messages", "locks", "creationBindings"],
      "readwrite",
      (tx, complete) => {
        const creations = tx.objectStore("creations");
        readCreation(creations, entry.id, (live) => {
          if (
            !live ||
            live.status !== "waiting" ||
            live.revision !== entry.revision ||
            live.payload.input.commandId !== entry.payload.input.commandId
          ) {
            complete(false);
            return;
          }
          const locks = tx.objectStore("locks");
          const capacityScope = `capacity:${payload.environmentId}`;
          const request = locks.get(capacityScope);
          request.onsuccess = () => {
            if (!manual && request.result && request.result.expiresAt > now) {
              complete(false);
              return;
            }
            const scope = scopedThreadKey(
              scopeThreadRef(payload.environmentId, payload.input.threadId),
            );
            tx.objectStore("messages").add(
              storedThreadOutboxEntry(
                createPendingThreadOutboxEntry(
                  {
                    id: payload.input.message.messageId,
                    scope,
                    createdAt:
                      payload.input.createdAt ?? payload.input.bootstrap.createThread.createdAt,
                    payload,
                  },
                  0,
                ),
              ),
            );
            creations.put({ ...live, payload, status: "bound", revision: live.revision + 1 });
            tx.objectStore("creationBindings").put(binding);
            locks.put({ scope: capacityScope, owner: entry.id, expiresAt: now + 5_000 });
            complete(true);
          };
        });
      },
    );
    if (bound) notifyThreadOutboxStorage();
    return bound;
  },
};
