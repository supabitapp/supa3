import { ManagedRelay } from "@supacode/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as ManagedRelayLayer from "./managedRelayLayer";
import { resolveCloudPublicConfig } from "./publicConfig";
import * as Runtime from "../lib/runtime";

// Source deployments opt in with their own relay origin. Acquire this graph only
// from the configured account UI, so stock clients never initialize account auth.
export const layer: Layer.Layer<
  ManagedRelay.ManagedRelayClient | ManagedRelay.ManagedRelayDpopSigner
> = Layer.unwrap(
  Effect.sync(() => {
    const url = resolveCloudPublicConfig().relayUrl;
    if (!url) throw new Error("No user-owned relay is configured.");
    return ManagedRelayLayer.layer(url).pipe(Layer.provide(Runtime.layer));
  }),
);
export const runtime: ManagedRuntime.ManagedRuntime<
  ManagedRelay.ManagedRelayClient | ManagedRelay.ManagedRelayDpopSigner,
  never
> = ManagedRuntime.make(layer);
