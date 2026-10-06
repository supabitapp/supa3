import { ManagedRelay, managedRelaySessionAtom } from "@supacode/client-runtime/relay";
import { ClientCapabilities } from "@supacode/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@supacode/client-runtime/connection";
import {
  RemoteDpopAccessTokenStore,
  type RemoteDpopAccessToken,
} from "@supacode/client-runtime/authorization/tokenStore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { layer as relayLayer } from "./runtime";

export const layer: Layer.Layer<
  | ManagedRelay.ManagedRelayClient
  | ManagedRelay.ManagedRelayDpopSigner
  | ClientCapabilities.CloudSession
  | ClientCapabilities.RelayDeviceIdentity
  | RemoteDpopAccessTokenStore
> = Layer.effectContext(
  Effect.sync(() => {
    const tokens = new Map<string, RemoteDpopAccessToken>();
    const session = ClientCapabilities.CloudSession.of({
      identity: Effect.sync(() =>
        Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
      ),
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (!session)
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to your relay account.",
          });
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            () =>
              new ConnectionTransientError({
                reason: "network",
                detail: "The account session could not be read.",
              }),
          ),
        );
        if (!token)
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to your relay account.",
          });
        return token;
      }),
    });
    // Web access credentials are cached only for this client session. Discovery
    // obtains replacements on reload through the original mint/DPoP protocol.
    return Context.make(ClientCapabilities.CloudSession, session).pipe(
      Context.add(ClientCapabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
      Context.add(RemoteDpopAccessTokenStore, {
        get: (id) => Effect.sync(() => Option.fromUndefinedOr(tokens.get(id))),
        put: (token) =>
          Effect.sync(() => {
            tokens.set(token.environmentId, token);
          }),
        remove: (id) =>
          Effect.sync(() => {
            tokens.delete(id);
          }),
      }),
    );
  }),
).pipe(Layer.provideMerge(relayLayer));
