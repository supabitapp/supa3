import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@supacode/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as CursorUsageReader from "./cursorUsageReader.ts";
import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./cursorAccountCache.ts";
import { readDirectoryVolumeId } from "./usageTranscriptReader.ts";
import type { ScannedUsageSource } from "./usageSource.ts";

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fnUntraced(function* (schedulePersist: () => Effect.Effect<void>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const cursorAccountReader = yield* CursorUsageReader.CursorAccountReader;
  const cursorCachePath = path.join(config.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);

  const cursorCaches = new Map<string, CursorAccountCache>();
  let cursorCacheDirty = false;

  const cursorFailures = new Map<
    string,
    { readonly atMs: number; readonly error: string | null }
  >();

  const cursorRefreshes = new Map<string, Deferred.Deferred<void>>();
  const load = fileSystem.readFileString(cursorCachePath).pipe(
    Effect.flatMap(decodeDocument),
    Effect.catchCause(() => Effect.succeed(null)),
    Effect.map((document) => {
      for (const [key, cache] of decodeCursorAccountCaches(document)) cursorCaches.set(key, cache);
    }),
  );

  const persist = Effect.gen(function* () {
    if (!cursorCacheDirty) return;
    cursorCacheDirty = false;
    yield* Effect.sync(() => encodeCursorAccountCaches(cursorCaches)).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: cursorCachePath, contents }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cursorCacheDirty = true;
        }),
      ),
    );
  });

  const refreshCursorAccount = Effect.fn("UsageService.refreshCursorAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fetchMissing = (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return cursorAccountReader
        .read(credential, range.sinceMs, range.untilMs)
        .pipe(Effect.map((result) => ({ range, result })));
    };
    let base = cursorCaches.get(credentialKey);
    let fetched = yield* fetchMissing(base);

    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      cursorCaches.delete(credentialKey);
      cursorCacheDirty = true;
      base = undefined;
      fetched = yield* fetchMissing(base);
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      cursorFailures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
      });
      yield* schedulePersist();
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
    cursorCaches.set(credentialKey, merged.cache);
    cursorFailures.delete(credentialKey);

    if (merged.changed) {
      cursorCacheDirty = true;
      yield* schedulePersist();
    }
  });

  const startCursorRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = cursorRefreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        cursorRefreshes.set(credentialKey, done);

        yield* refreshCursorAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) =>
                cursorFailures.set(credentialKey, { atMs, error: CURSOR_ACCOUNT_READ_ERROR }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              cursorRefreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  const cursorAccountSource = Effect.fn("UsageService.cursorAccountSource")(function* (
    credential: CursorCredentialSource,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    // No saved login means there is no account source to report, not a setup error.
    if (
      typeof credential === "string" &&
      !(yield* fileSystem.exists(credential).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return null;
    }
    const credentialKey = typeof credential === "string" ? credential : "keychain";
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = cursorFailures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(cursorCaches.get(credentialKey), nowMs)
    ) {
      const refresh = yield* startCursorRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) yield* Deferred.await(refresh);
      else refreshing = true;
    }

    const cache = cursorCaches.get(credentialKey);
    const failure = refreshing ? undefined : cursorFailures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        provider: "cursor",
        dir: authPath,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(authPath)),
        // Never combine a local fallback with another server's account-wide history.
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      } satisfies ScannedUsageSource;
    }
    // The same account includes CLI and desktop history from every machine.
    // A stable remote fingerprint prevents connected environments counting it twice.
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
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ScannedUsageSource;
  });

  return { read: cursorAccountSource, load, persist } as const;
});
