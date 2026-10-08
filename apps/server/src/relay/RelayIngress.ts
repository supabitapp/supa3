// @effect-diagnostics nodeBuiltinImport:off - identifies the synthetic Node HTTP socket.
import type { TunnelStream } from "@supacode/shared/relay/tunnel";
import { TunnelSocket } from "@supacode/shared/relay/tunnelNode";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

export class RelayIngress extends Context.Service<
  RelayIngress,
  {
    readonly accept: (stream: TunnelStream) => void;
  }
>()("supacode/relay/RelayIngress") {}

export const isRelayedRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof Object &&
  "socket" in request.source &&
  request.source.socket instanceof TunnelSocket;

export const isRelayPath = (pathname: string) =>
  pathname === "/ws" ||
  pathname.startsWith("/api/") ||
  pathname === "/oauth/token" ||
  pathname === "/.well-known/supacode/environment";

export const layerPathGuard = HttpRouter.middleware(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (isRelayedRequest(request) && !isRelayPath(new URL(request.url, "http://relay").pathname))
        return HttpServerResponse.empty({ status: 404 });
      return yield* app;
    }),
  { global: true },
);
