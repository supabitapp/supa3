import { isTransportConnectionErrorMessage } from "./errors/transport.ts";

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 16_000);
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "OrchestrationDispatchCommandError":
      case "EnvironmentAuthorizationError":
        return false;
      case "ConnectionTransientError":
      case "RpcClientError":
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
        return true;
    }
  }
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : null;
  return isTransportConnectionErrorMessage(message);
}

export interface ThreadOutboxEntry<Payload> {
  readonly id: string;
  readonly scope: string;
  readonly createdAt: string;
  readonly position: number;
  readonly payload: Payload;
  readonly status: "pending" | "failed" | "delivered";
  /** An unacknowledged attempt must keep its original payload and identifiers. */
  readonly attempted: boolean;
  readonly attempts: number;
  readonly retryAt: number;
  readonly error: string | null;
  readonly paused: boolean;
  readonly pauseUntil: number;
}

export interface ThreadOutboxStorage<Payload> {
  readonly load: () => Promise<ReadonlyArray<ThreadOutboxEntry<Payload>>>;
  /** Updates an existing entry; false when another client has removed it. */
  readonly write: (entry: ThreadOutboxEntry<Payload>) => Promise<boolean>;
  readonly writeMany: (entries: ReadonlyArray<ThreadOutboxEntry<Payload>>) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  /** Serializes delivery and edits across clients sharing the same local storage. */
  readonly withLock: <A>(scope: string, action: () => Promise<A>) => Promise<A | null>;
}

/** Durable FIFO delivery per thread; platforms own storage, wakeups and transport. */
export function createThreadOutbox<Payload>(options: {
  readonly storage: ThreadOutboxStorage<Payload>;
  readonly now: () => number;
  readonly canDeliver: (entry: ThreadOutboxEntry<Payload>) => boolean;
  readonly deliver: (
    entry: ThreadOutboxEntry<Payload>,
    savePayload: (payload: Payload) => Promise<void>,
  ) => Promise<void>;
  readonly shouldRetry?: (error: unknown) => boolean;
}) {
  let entries: ReadonlyArray<ThreadOutboxEntry<Payload>> = [];
  const listeners = new Set<() => void>();
  const sending = new Set<string>();
  let loadPromise: Promise<void> | null = null;
  let drainPromise: Promise<number | null> | null = null;
  let position = 0;

  function publish(next: ReadonlyArray<ThreadOutboxEntry<Payload>>) {
    entries = [...next].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.position - b.position,
    );
    for (const entry of entries) position = Math.max(position, entry.position);
    for (const listener of listeners) listener();
  }

  async function reload() {
    publish(await options.storage.load());
  }

  function load() {
    loadPromise ??= reload().catch((error) => {
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  }

  async function save(entry: ThreadOutboxEntry<Payload>) {
    if (!(await options.storage.write(entry))) {
      publish(entries.filter((candidate) => candidate.id !== entry.id));
      return false;
    }
    publish([...entries.filter((candidate) => candidate.id !== entry.id), entry]);
    return true;
  }

  async function remove(id: string) {
    await options.storage.remove(id);
    publish(entries.filter((entry) => entry.id !== id));
  }

  async function enqueueMany(
    inputs: ReadonlyArray<
      Pick<ThreadOutboxEntry<Payload>, "id" | "scope" | "createdAt" | "payload">
    >,
  ) {
    await load();
    // Publish only after the storage transaction commits. Callers may now clear their draft.
    const added = inputs.map((input) => ({
      ...input,
      position: ++position,
      status: "pending" as const,
      attempted: false,
      attempts: 0,
      retryAt: 0,
      error: null,
      paused: false,
      pauseUntil: 0,
    }));
    await options.storage.writeMany(added);
    const ids = new Set(added.map((entry) => entry.id));
    publish([...entries.filter((entry) => !ids.has(entry.id)), ...added]);
  }

  function enqueue(
    input: Pick<ThreadOutboxEntry<Payload>, "id" | "scope" | "createdAt" | "payload">,
  ) {
    return enqueueMany([input]);
  }

  async function mutate(
    id: string,
    change: (entry: ThreadOutboxEntry<Payload>) => ThreadOutboxEntry<Payload> | null,
  ) {
    await load();
    const candidate = entries.find((entry) => entry.id === id);
    if (!candidate) return false;
    return (
      (await options.storage.withLock(`message:${id}`, async () => {
        const live = (await options.storage.load()).find((entry) => entry.id === id);
        if (!live || live.status === "delivered" || (live.attempted && live.status !== "failed"))
          return false;
        const next = change(live);
        if (next === null) await remove(id);
        else if (!(await save(next))) return false;
        return true;
      })) ?? false
    );
  }

  function edit(id: string, payload: Payload, scope?: string) {
    return mutate(id, (entry) => ({
      ...entry,
      ...(scope === undefined ? {} : { scope }),
      payload,
      status: "pending",
      attempted: false,
      attempts: 0,
      retryAt: 0,
      error: null,
      paused: false,
      pauseUntil: 0,
    }));
  }

  function pause(id: string, paused: boolean) {
    return mutate(id, (entry) => ({
      ...entry,
      paused,
      pauseUntil: paused ? options.now() + 60_000 : 0,
    }));
  }

  function cancel(id: string) {
    return mutate(id, () => null);
  }

  async function deliverScope(scope: string): Promise<number | null> {
    const locked = await options.storage.withLock(scope, async () => {
      // Another tab may have cancelled, edited or delivered this row since our snapshot.
      const candidate = (await options.storage.load())
        .filter((entry) => entry.scope === scope)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.position - b.position)[0];
      if (!candidate) {
        publish(entries.filter((entry) => entry.scope !== scope));
        return { next: null };
      }
      const messageLock = await options.storage.withLock(`message:${candidate.id}`, async () => {
        const head = (await options.storage.load()).find(
          (entry) => entry.id === candidate.id && entry.scope === scope,
        );
        if (!head) return { next: options.now() };
        if (head.status === "delivered") {
          await remove(head.id);
          return { next: options.now() };
        }
        if (head.status === "failed" || !options.canDeliver(head)) return { next: null };
        // Editors renew this lease. A crash must not leave a message paused forever.
        if (head.paused && head.pauseUntil > options.now()) return { next: head.pauseUntil };
        if (head.retryAt > options.now()) return { next: head.retryAt };
        let current = {
          ...head,
          paused: false,
          pauseUntil: 0,
          attempted: true,
          attempts: head.attempts + 1,
        };
        if (!(await save(current))) return { next: null };
        sending.add(current.id);
        publish(entries);
        try {
          await options.deliver(current, async (payload) => {
            current = { ...current, payload };
            if (!(await save(current))) throw new Error("The pending message was removed.");
          });
        } catch (error) {
          const retry = (options.shouldRetry ?? shouldRetryThreadOutboxDelivery)(error);
          current = {
            ...current,
            status: retry ? "pending" : "failed",
            retryAt: retry ? options.now() + threadOutboxRetryDelayMs(current.attempts) : 0,
            error: error instanceof Error ? error.message : String(error),
          };
          await save(current);
          return { next: retry ? current.retryAt : null };
        } finally {
          sending.delete(current.id);
          publish(entries);
        }
        // Record acknowledgement before cleanup, so failed deletion can never resend the turn.
        await save({ ...current, status: "delivered", error: null });
        await remove(current.id);
        return { next: options.now() };
      });
      return messageLock ?? { next: options.now() + 1_000 };
    });
    return locked === null &&
      entries.some(
        (entry) =>
          entry.scope === scope &&
          entry.status === "pending" &&
          !entry.paused &&
          options.canDeliver(entry),
      )
      ? options.now() + 1_000
      : (locked?.next ?? null);
  }

  function drain(): Promise<number | null> {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      await load();
      const scopes = [...new Set(entries.map((entry) => entry.scope))];
      const remaining = scopes.values();
      const next: Array<number | null> = [];
      // Bound uploads and RPC work when many threads reconnect together.
      await Promise.all(
        Array.from({ length: Math.min(3, scopes.length) }, async () => {
          for (let scope = remaining.next(); !scope.done; scope = remaining.next()) {
            next.push(await deliverScope(scope.value));
          }
        }),
      );
      const times = next.filter((time) => time !== null);
      return times.length > 0 ? Math.min(...times) : null;
    })().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  return {
    load,
    reload,
    enqueue,
    enqueueMany,
    edit,
    pause,
    cancel,
    drain,
    getSnapshot: () => entries,
    isSending: (id: string) => sending.has(id),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
