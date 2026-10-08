import { relayHttpBaseUrl, relayPublicKey } from "@supacode/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class RelayIdentity extends Context.Service<
  RelayIdentity,
  {
    readonly secret: Uint8Array;
    readonly address: string;
  }
>()("supacode/relay/RelayIdentity") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* secrets.getOrCreateRandom("relay-identity", 32);
  return RelayIdentity.of({ secret, address: relayHttpBaseUrl(relayPublicKey(secret)) });
});

export const layer = Layer.effect(RelayIdentity, make);
