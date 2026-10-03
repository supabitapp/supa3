import * as ExpoCrypto from "expo-crypto";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
  remoteHttpClientLayer,
  relayWebSocketLayer,
  relayClientOptions,
} from "@t3tools/client-runtime/rpc";

import * as Persistence from "../persistence/layer";
import { cryptoLayer } from "./crypto";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const relayOptions = relayClientOptions(ExpoCrypto.getRandomBytes);
const socketLayer = relayWebSocketLayer(relayOptions);
const httpClientLayer = remoteHttpClientLayer(fetch, relayOptions);

type RuntimeLayerSource =
  | typeof socketLayer
  | typeof cryptoLayer
  | typeof httpClientLayer
  | typeof Persistence.layer;

const runtimeLayer = socketLayer.pipe(
  Layer.provideMerge(cryptoLayer),
  Layer.provideMerge(httpClientLayer),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
