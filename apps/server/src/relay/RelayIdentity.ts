import { relayHttpBaseUrl, relayPublicKey } from "@supacode/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class RelayIdentity extends Context.Service<
  RelayIdentity,
  {
    readonly get: Effect.Effect<
      { readonly secret: Uint8Array; readonly address: string },
      ServerSecretStore.SecretStoreError
    >;
  }
>()("supacode/relay/RelayIdentity") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const get = yield* Effect.cached(
    secrets
      .getOrCreateRandom("relay-identity", 32)
      .pipe(
        Effect.map((secret) => ({ secret, address: relayHttpBaseUrl(relayPublicKey(secret)) })),
      ),
  );
  return RelayIdentity.of({ get });
});

export const layer = Layer.effect(RelayIdentity, make);
