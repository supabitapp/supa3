import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./cursorAccountCache.ts";
import * as CursorUsageReader from "./cursorUsageReader.ts";
import { readDirectoryVolumeId } from "./usageTranscriptReader.ts";

const ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

export const makeCursorAccountSource = Effect.fn("CursorAccountSource.make")(function* (options: {
  readonly loadCache: Effect.Effect<unknown, PlatformError.PlatformError | Schema.SchemaError>;
  readonly persistCache: (contents: string) => Effect.Effect<void, PlatformError.PlatformError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const accountReader = yield* CursorUsageReader.CursorAccountReader;
  const caches = new Map<string, CursorAccountCache>();
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  const refreshes = new Map<string, Deferred.Deferred<void>>();
  let dirty = false;

  const load = yield* Effect.cached(
    options.loadCache.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
      }),
    ),
  );

  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!dirty) return;
    dirty = false;
    yield* Effect.sync(() => encodeCursorAccountCaches(caches)).pipe(
      Effect.flatMap(options.persistCache),
      Effect.catchCause(() =>
        Effect.sync(() => {
          dirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("CursorAccountSource.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const refreshAccount = Effect.fn("CursorAccountSource.refreshAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fetchMissing = (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return accountReader
        .read(credential, range.sinceMs, range.untilMs)
        .pipe(Effect.map((result) => ({ range, result })));
    };
    let base = caches.get(credentialKey);
    let fetched = yield* fetchMissing(base);
    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      caches.delete(credentialKey);
      dirty = true;
      base = undefined;
      fetched = yield* fetchMissing(base);
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      failures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : ACCOUNT_READ_ERROR,
      });
      yield* schedulePersist;
      return;
    }
    const merged = mergeCursorFetch(
      base,
      result.accountKey,
      range,
      result.records,
      nowMs,
      retentionStartMs,
    );
    caches.set(credentialKey, merged.cache);
    failures.delete(credentialKey);
    if (merged.changed) {
      dirty = true;
      yield* schedulePersist;
    }
  });

  const startRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = refreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        refreshes.set(credentialKey, done);
        yield* refreshAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) =>
                failures.set(credentialKey, { atMs, error: ACCOUNT_READ_ERROR }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              refreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  const read = Effect.fn("CursorAccountSource.read")(function* (
    credential: CursorCredentialSource,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    if (
      typeof credential === "string" &&
      !(yield* fileSystem.exists(credential).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return null;
    }
    const credentialKey = typeof credential === "string" ? credential : "keychain";
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = failures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs)
    ) {
      const refresh = yield* startRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) yield* Deferred.await(refresh);
      else refreshing = true;
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        provider: "cursor",
        dir: authPath,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(authPath)),
        ...(refreshing
          ? ({ files: [], status: "partial", refreshing: true } as const)
          : { files: null, message: failureMessage ?? ACCOUNT_READ_ERROR }),
      } as const;
    }
    const source = `cursor-account:${cache.accountKey}`;
    return {
      provider: "cursor",
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
      ...(failureMessage === undefined
        ? ({ status: refreshing ? "partial" : "ok" } as const)
        : ({ status: "partial", message: failureMessage } as const)),
      ...(refreshing ? ({ refreshing: true } as const) : {}),
    } as const;
  });

  return { load, persist, read, awaitPersisted } as const;
});
