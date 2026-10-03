import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { relayHttpBaseUrl, relayPublicKey } from "@supacode/shared/relay/protocol";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { startRelayTransport } from "./transport.ts";

export class RelayAccess extends Context.Service<
  RelayAccess,
  {
    readonly address: string;
    readonly start: (localOrigin: string) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("supacode/relay/RelayAccess") {}

const make = Effect.gen(function* () {
  const fetch = yield* FetchHttpClient.Fetch;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secret = yield* secrets.getOrCreateRandom("relay-identity", 32).pipe(Effect.orDie);
  return RelayAccess.of({
    address: relayHttpBaseUrl(relayPublicKey(secret)),
    start: Effect.fn("RelayAccess.start")(function* (localOrigin: string) {
      let stop: (() => void) | undefined;
      const apply = (enabled: boolean) =>
        Effect.sync(() => {
          if (enabled && !stop) stop = startRelayTransport({ secret, localOrigin, fetch });
          if (!enabled) {
            stop?.();
            stop = undefined;
          }
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => stop?.()));
      const changes = yield* settings.subscribeChanges;
      yield* Stream.runForEach(changes, (value) => apply(value.publicRelayEnabled)).pipe(
        Effect.forkScoped,
      );
      const current = yield* settings.getSettings.pipe(Effect.orDie);
      yield* apply(current.publicRelayEnabled);
    }),
  });
});
export const layer = Layer.effect(RelayAccess, make);
