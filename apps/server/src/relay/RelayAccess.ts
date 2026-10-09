import {
  normalizeRelayServerUrl,
  relayAdvertisementFrom,
  type RelayAdvertisement,
  type RelayHostStatus,
  type ServerSettings,
} from "@supacode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSettingsService from "../serverSettings.ts";
import { RelayIdentity } from "./RelayIdentity.ts";
import { RelayIngress } from "./RelayIngress.ts";
import { type RelayHostState as TransportState, startRelayTransport } from "./transport.ts";

export class RelayAccess extends Context.Service<
  RelayAccess,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly status: Stream.Stream<RelayHostStatus>;
    readonly advertisements: Stream.Stream<RelayAdvertisement | null>;
    readonly advertisement: Effect.Effect<Pick<RelayHostStatus, "relayEndpoint" | "relayUrl">>;
  }
>()("supacode/relay/RelayAccess") {}

const make = Effect.gen(function* () {
  const identity = yield* RelayIdentity;
  const ingress = yield* RelayIngress;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const status = yield* SubscriptionRef.make<RelayHostStatus>({ state: "off" });

  const start = Effect.gen(function* () {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let running: { readonly relayUrl: string; readonly stop: () => void } | undefined;
    const stop = () => {
      running?.stop();
      running = undefined;
    };
    const report = (state: TransportState, address: string, relayUrl: string) => {
      if (state === "stopped") return;
      runFork(
        Effect.gen(function* () {
          if (running?.relayUrl !== relayUrl) return;
          if (state === "registered")
            yield* Effect.logInfo("Public relay registered", { relayUrl });
          if (state === "superseded")
            yield* Effect.logWarning(
              "Public relay identity is active on another host; reconnect is stopped.",
            );
          yield* SubscriptionRef.set(status, { state, relayEndpoint: address, relayUrl });
        }),
      );
    };
    const apply = Effect.fn("RelayAccess.apply")(function* (value: ServerSettings) {
      const relayUrl = value.publicRelayEnabled
        ? normalizeRelayServerUrl(value.publicRelayUrl)
        : null;
      if (running !== undefined && running.relayUrl === relayUrl) return;
      stop();
      if (!value.publicRelayEnabled) return yield* SubscriptionRef.set(status, { state: "off" });
      if (relayUrl === null) {
        yield* Effect.logWarning("Public relay URL is invalid", { relayUrl: value.publicRelayUrl });
        return yield* SubscriptionRef.set(status, { state: "invalid-url" });
      }
      const { secret, address } = yield* identity.get;
      running = {
        relayUrl,
        stop: startRelayTransport({
          secret,
          relayUrl,
          acceptStream: ingress.accept,
          onStatus: (state) => report(state, address, relayUrl),
        }),
      };
      yield* SubscriptionRef.set(status, { state: "connecting", relayEndpoint: address, relayUrl });
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(stop).pipe(Effect.andThen(SubscriptionRef.set(status, { state: "off" }))),
    );
    const changes = yield* settings.subscribeChanges;
    yield* Stream.concat(Stream.fromEffect(settings.getSettings.pipe(Effect.orDie)), changes).pipe(
      Stream.runForEach((value) =>
        apply(value).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Public relay could not start", { error }).pipe(
              Effect.andThen(SubscriptionRef.set(status, { state: "off" })),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });

  return RelayAccess.of({
    start,
    status: SubscriptionRef.changes(status),
    advertisements: SubscriptionRef.changes(status).pipe(
      Stream.map(relayAdvertisementFrom),
      Stream.changesWith<RelayAdvertisement | null>(Equal.equals),
    ),
    advertisement: SubscriptionRef.get(status).pipe(
      Effect.map((value) => relayAdvertisementFrom(value) ?? {}),
    ),
  });
});

export const layer = Layer.effect(RelayAccess, make);
