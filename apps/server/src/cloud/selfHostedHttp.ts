import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as SelfHostedEndpoint from "./SelfHostedEndpoint.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "remoteAccess",
  Effect.fnUntraced(function* (handlers) {
    const endpoint = yield* SelfHostedEndpoint.SelfHostedEndpoint;
    return handlers
      .handle("status", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.andThen(endpoint.getStatus),
        ),
      )
      .handle("setup", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(Effect.andThen(endpoint.setup)),
      )
      .handle("configure", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(
          Effect.andThen(endpoint.configure(payload)),
        ),
      )
      .handle("setEnabled", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(
          Effect.andThen(endpoint.setEnabled(payload.enabled)),
        ),
      )
      .handle("repair", () =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(endpoint.repair)),
      )
      .handle("remove", () =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(endpoint.remove)),
      );
  }),
);
