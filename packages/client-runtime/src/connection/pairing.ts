import type { EnvironmentId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { ROUTE_CHECK_TIMEOUT_MS } from "./driver.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import { ConnectionBlockedError } from "./model.ts";
import type { PairingFallback } from "./routes.ts";

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

const reachDescriptor = Effect.fnUntraced(function* (
  httpBaseUrl: string,
  source: "linked" | "saved" | "hint",
  expectedEnvironmentId: EnvironmentId | undefined,
) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  if (expectedEnvironmentId !== undefined && descriptor.environmentId !== expectedEnvironmentId) {
    return yield* differentMachineError(descriptor.label);
  }
  return { httpBaseUrl, descriptor, source };
});

export const reachPairingServer = Effect.fn("clientRuntime.connection.pairing.reachPairingServer")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly expectedEnvironmentId: EnvironmentId | undefined;
    readonly fallback: PairingFallback | null;
    readonly routes: ReadonlyArray<string>;
  }) {
    const candidates = new Map<string, { httpBaseUrl: string; source: "saved" | "hint" }>();
    const linkedOrigin = new URL(input.httpBaseUrl).origin;
    for (const [source, urls] of [
      ["saved", input.fallback?.httpBaseUrls ?? []],
      ["hint", input.routes],
    ] as const) {
      for (const httpBaseUrl of urls) {
        const url = new URL(httpBaseUrl);
        if (url.origin === linkedOrigin || candidates.has(url.origin)) continue;
        if (
          url.protocol === "http:" &&
          typeof globalThis.location !== "undefined" &&
          globalThis.location.protocol === "https:"
        )
          continue;
        candidates.set(url.origin, { httpBaseUrl, source });
      }
    }
    const linkedAddress = reachDescriptor(input.httpBaseUrl, "linked", input.expectedEnvironmentId);
    if (candidates.size === 0) return yield* linkedAddress;
    const linked = yield* Effect.forkScoped(linkedAddress);
    const answered = yield* Fiber.join(linked).pipe(
      Effect.timeoutOption(ROUTE_CHECK_TIMEOUT_MS),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(answered)) return answered.value;
    return yield* Effect.raceAll([
      Fiber.join(linked),
      ...[...candidates.values()].map(({ httpBaseUrl, source }) =>
        reachDescriptor(
          httpBaseUrl,
          source,
          input.expectedEnvironmentId ?? input.fallback?.environmentId,
        ),
      ),
    ]).pipe(Effect.catch(() => Fiber.join(linked)));
  },
  Effect.scoped,
);
