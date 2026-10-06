import * as RelayClient from "@supacode/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";

export const layer = Layer.unwrap(
  ServerConfig.ServerConfig.pipe(
    Effect.map((config) => RelayClient.layerCloudflared({ baseDir: config.baseDir })),
  ),
);
