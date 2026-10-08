import * as Schema from "effect/Schema";

const Metadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  lastModified: Schema.Number,
  unreferencedSince: Schema.NullOr(Schema.Number),
});
const Usage = Schema.Struct({
  actor: Schema.String,
  ids: Schema.Array(Schema.String),
});
const decodeMetadata = Schema.decodeUnknownSync(Metadata);
const decodeUsage = Schema.decodeUnknownSync(Usage);
const decodeBlob = Schema.decodeUnknownSync(Schema.instanceOf(Blob));
const decodeTotal = Schema.decodeUnknownSync(Schema.Number);
const GRACE_MS = 24 * 60 * 60_000;
const CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

export function createDraftAttachmentByteStorage(options: {
  readonly actor: string;
  readonly factory: () => IDBFactory | undefined;
  readonly databaseName?: string;
  readonly budgetBytes?: number;
  readonly now?: () => number;
}) {
  let database: Promise<IDBDatabase> | null = null;
  const now = options.now ?? Date.now;

  function open() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.factory();
      if (!factory) {
        reject(new Error("Local attachment storage is unavailable."));
        return;
      }
      const request = factory.open(options.databaseName ?? "supacode-draft-attachment-bytes", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("bytes");
        request.result.createObjectStore("metadata", { keyPath: "id" });
        request.result.createObjectStore("usage", { keyPath: "actor" });
        request.result.createObjectStore("totals");
      };
      let blocked = false;
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.addEventListener("versionchange", () => {
          db.close();
          database = null;
        });
        resolve(db);
      };
      request.addEventListener("error", () => reject(request.error));
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Local attachment storage is being upgraded."));
      };
    }).catch((error: unknown) => {
      database = null;
      throw error;
    });
    return database;
  }

  async function transaction<A>(
    stores: string[],
    operation: (tx: IDBTransaction, complete: (value: A) => void) => void,
  ): Promise<A> {
    const db = await open();
    return new Promise<A>((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      let result: A;
      tx.addEventListener("complete", () => resolve(result));
      tx.addEventListener("error", () => reject(tx.error));
      tx.addEventListener("abort", () =>
        reject(tx.error ?? new Error("Local attachment storage was interrupted.")),
      );
      try {
        operation(tx, (value) => {
          result = value;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  function onSuccess(request: IDBRequest, tx: IDBTransaction, handle: () => void) {
    request.onsuccess = () => {
      try {
        handle();
      } catch {
        tx.abort();
      }
    };
  }

  function writeUsage(tx: IDBTransaction, ids: ReadonlySet<string>) {
    tx.objectStore("usage").put({ actor: options.actor, ids: [...ids] });
  }

  return {
    save: (id: string, file: File, liveIds: ReadonlySet<string>) =>
      transaction<"cached" | "budget">(["bytes", "metadata", "usage", "totals"], (tx, complete) => {
        const existing = tx.objectStore("metadata").get(id);
        const total = tx.objectStore("totals").get("bytes");
        onSuccess(total, tx, () => {
          const old = existing.result === undefined ? null : decodeMetadata(existing.result);
          if (old) {
            if (old.name !== file.name || old.mimeType !== file.type || old.sizeBytes !== file.size)
              throw new Error("Attachment cache keys cannot be reused for different bytes.");
            tx.objectStore("metadata").put({ ...old, unreferencedSince: null });
            writeUsage(tx, new Set([...liveIds, id]));
            complete("cached");
            return;
          }
          const used = total.result === undefined ? 0 : decodeTotal(total.result);
          const nextTotal = used + file.size;
          if (nextTotal > (options.budgetBytes ?? CACHE_BUDGET_BYTES)) {
            complete("budget");
            return;
          }
          tx.objectStore("bytes").put(file, id);
          tx.objectStore("metadata").put({
            id,
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            lastModified: file.lastModified,
            unreferencedSince: null,
          });
          tx.objectStore("totals").put(nextTotal, "bytes");
          writeUsage(tx, new Set([...liveIds, id]));
          complete("cached");
        });
      }),
    load: (id: string, liveIds: ReadonlySet<string>) =>
      transaction<File | null>(["bytes", "metadata", "usage"], (tx, complete) => {
        const metadata = tx.objectStore("metadata").get(id);
        const bytes = tx.objectStore("bytes").get(id);
        onSuccess(bytes, tx, () => {
          if (metadata.result === undefined || bytes.result === undefined) {
            complete(null);
            return;
          }
          const row = decodeMetadata(metadata.result);
          const blob = decodeBlob(bytes.result);
          writeUsage(tx, new Set([...liveIds, id]));
          tx.objectStore("metadata").put({ ...row, unreferencedSince: null });
          complete(
            new File([blob], row.name, { type: row.mimeType, lastModified: row.lastModified }),
          );
        });
      }),
    updateUsage: (ids: ReadonlySet<string>) =>
      transaction<void>(["usage"], (tx, complete) => {
        writeUsage(tx, ids);
        complete(undefined);
      }),
    releaseUsage: () =>
      transaction<void>(["usage"], (tx, complete) => {
        tx.objectStore("usage").delete(options.actor);
        complete(undefined);
      }),
    collect: (readReferences: () => ReadonlySet<string> | null) =>
      transaction<number>(["bytes", "metadata", "usage", "totals"], (tx, complete) => {
        const metadata = tx.objectStore("metadata").getAll();
        const usage = tx.objectStore("usage").getAll();
        const total = tx.objectStore("totals").get("bytes");
        onSuccess(total, tx, () => {
          const referenced = readReferences();
          if (referenced === null) {
            complete(0);
            return;
          }
          const held = new Set(referenced);
          for (const entry of usage.result as unknown[]) {
            for (const id of decodeUsage(entry).ids) held.add(id);
          }
          let deletedBytes = 0;
          for (const entry of metadata.result as unknown[]) {
            const row = decodeMetadata(entry);
            if (held.has(row.id)) {
              if (row.unreferencedSince !== null)
                tx.objectStore("metadata").put({ ...row, unreferencedSince: null });
            } else if (row.unreferencedSince === null) {
              tx.objectStore("metadata").put({ ...row, unreferencedSince: now() });
            } else if (now() - row.unreferencedSince >= GRACE_MS) {
              tx.objectStore("bytes").delete(row.id);
              tx.objectStore("metadata").delete(row.id);
              deletedBytes += row.sizeBytes;
            }
          }
          const used = total.result === undefined ? 0 : decodeTotal(total.result);
          tx.objectStore("totals").put(Math.max(0, used - deletedBytes), "bytes");
          complete(deletedBytes);
        });
      }),
  };
}
