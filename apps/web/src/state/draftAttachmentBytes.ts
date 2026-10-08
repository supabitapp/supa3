import { createDraftAttachmentByteStorage } from "./draftAttachmentByteStorage";
import { randomUUID } from "../lib/randomUUID";
import { createConcurrencyLimiter } from "../lib/concurrencyLimiter";

export type DraftAttachmentRetention = "cached" | "session-only";

const storage = createDraftAttachmentByteStorage({
  actor: randomUUID(),
  factory: () => (typeof indexedDB === "undefined" ? undefined : indexedDB),
});
const holds = new Map<string, number>();
const saves = new WeakMap<File, Map<string, Promise<DraftAttachmentRetention>>>();
const acquire = createConcurrencyLimiter(2);
let readLiveReferences: () => ReadonlySet<string> = () => new Set();
let readPersistedReferences: () => ReadonlySet<string> | null = () => null;
let scheduledUsage: Promise<void> | null = null;

function liveIds() {
  return new Set([...readLiveReferences(), ...holds.keys()]);
}

function updateUsage() {
  scheduledUsage ??= Promise.resolve().then(() => {
    scheduledUsage = null;
    return storage.updateUsage(liveIds()).catch(() => {});
  });
  return scheduledUsage;
}

function acquireHold(ids: ReadonlyArray<string>) {
  for (const id of ids) holds.set(id, (holds.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) {
      const count = (holds.get(id) ?? 1) - 1;
      if (count > 0) holds.set(id, count);
      else holds.delete(id);
    }
    void updateUsage();
  };
}

async function collect() {
  await updateUsage();
  await storage
    .collect(() => {
      const persisted = readPersistedReferences();
      return persisted === null ? null : new Set([...persisted, ...liveIds()]);
    })
    .catch(() => {});
}

export const draftAttachmentBytes = {
  save: (id: string, file: File) => {
    const byId = saves.get(file) ?? new Map();
    const existing = byId.get(id);
    if (existing) return existing;
    const release = acquireHold([id]);
    const saved = acquire(async () => {
      try {
        const result = await storage.save(id, file, liveIds());
        if (result === "cached") return "cached" as const;
        await collect();
        return (await storage.save(id, file, liveIds())) === "cached"
          ? ("cached" as const)
          : ("session-only" as const);
      } catch {
        return "session-only" as const;
      }
    }).finally(release);
    byId.set(id, saved);
    saves.set(file, byId);
    void saved.then(() => {
      byId.delete(id);
    });
    return saved;
  },
  load: (id: string) => {
    const release = acquireHold([id]);
    return acquire(() => storage.load(id, liveIds())).finally(release);
  },
  hold: (ids: ReadonlyArray<string>) => {
    const release = acquireHold(ids);
    void updateUsage();
    return release;
  },
  start: (readers: {
    readonly live: () => ReadonlySet<string>;
    readonly persisted: () => ReadonlySet<string> | null;
  }) => {
    readLiveReferences = readers.live;
    readPersistedReferences = readers.persisted;
    void collect();
    if (typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      void collect();
    }, 10 * 60_000);
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) {
        window.clearInterval(timer);
        void storage.releaseUsage().catch(() => {});
      }
    });
    window.addEventListener("pageshow", () => {
      void collect();
    });
  },
};
