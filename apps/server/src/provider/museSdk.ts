// @effect-diagnostics globalTimers:off

import {
  spawnMspConnection,
  type Connection,
  type ProcessExit,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type { RuntimeMode } from "@supacode/contracts";
import * as Effect from "effect/Effect";

export interface MuseSdkHost {
  readonly connection: Pick<
    Connection,
    | "command"
    | "request"
    | "mintCommandId"
    | "onNotification"
    | "onServerRequest"
    | "onProtocolError"
    | "closed"
  >;
  readonly initializeResult: Pick<SpawnedMspConnection["initializeResult"], "grantedCapabilities">;
  readonly exited: Promise<ProcessExit>;

  readonly stderrTail?: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface MuseSdkHostOptions {
  readonly binaryPath: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;

  readonly readOnly?: boolean;

  readonly sessionLogging?: boolean;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
}

export function makeMuseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.keys(environment)
        .filter((key) => key.toUpperCase() !== "META_API_KEY")
        .map((key) => [key, environment[key]]),
    ),
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

export function museApprovalMode(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
}

export function museServeArgs(
  options: Pick<MuseSdkHostOptions, "readOnly" | "sessionLogging" | "runtimeMode">,
) {
  const args = ["serve"];
  if (options.readOnly) {
    args.push("--disable-shell", "--disable-write");
    if (options.sessionLogging !== true) args.push("--no-session-log");
  } else {
    args.push("--trust-workspace");
    if (options.runtimeMode === "full-access") args.push("--disable-sandbox");
  }
  return args;
}

export function museInitializeParams(readOnly = false) {
  return {
    clientInfo: { name: "supacode_code", title: "Supacode", version: "1" },
    capabilities: { requestedCapabilities: readOnly ? [] : ["sessionMcp"] },
  };
}

export async function createMuseSdkHost(
  options: MuseSdkHostOptions,
  spawn: typeof spawnMspConnection = spawnMspConnection,
): Promise<MuseSdkHost> {
  options.signal?.throwIfAborted();
  const handshake = spawn({
    command: options.binaryPath,
    args: museServeArgs(options),
    ...(options.cwd ? { cwd: options.cwd } : {}),

    env: options.environment ?? makeMuseEnvironment(),

    shutdownTimeoutMs: 10_000,
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    options.signal?.removeEventListener("abort", onAbort);
    return (closePromise ??= handshake.close().then(() => undefined));
  };
  let rejectStartup: (reason: unknown) => void = () => {};
  const onAbort = () => {
    rejectStartup(options.signal?.reason ?? new Error("Muse SDK startup aborted."));
    void close().catch(() => {});
  };
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () => rejectStartup(new Error("Muse SDK initialization timed out.")),
    options.startupTimeoutMs ?? 20_000,
  );
  timer.unref();
  try {
    const host = await Promise.race([
      handshake.initialize(museInitializeParams(options.readOnly)),
      interrupted,
    ]);
    if (host.initializeResult.schema?.version !== 1) {
      throw new Error("Muse SDK returned an unsupported protocol envelope version.");
    }

    return {
      connection: host.connection,
      initializeResult: host.initializeResult,
      exited: host.exited,
      stderrTail: () => handshake.child.stderrTail,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const createMuseSdkHostEffect = Effect.fn("createMuseSdkHostEffect")(function* (
  options: Omit<MuseSdkHostOptions, "signal">,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  let startup: Promise<MuseSdkHost> | undefined;
  return yield* Effect.tryPromise((signal) => {
    startup = createHost({ ...options, signal });
    return startup;
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await startup?.then(
          (host) => host.close(),
          () => {},
        );
      }),
    ),
  );
});
