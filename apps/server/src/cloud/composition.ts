import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as Activation from "../serverActivation.ts";
import * as ServerConfig from "../config.ts";
import {
  retryManagedTunnelRegistration,
  managedTunnelStartupAction,
  MANAGED_TUNNEL_RECOVERY_COOLDOWN,
} from "./managedTunnelStartup.ts";
import * as Duration from "effect/Duration";
import { EnvironmentHttpApi, EnvironmentHttpForbiddenError } from "@supacode/contracts";
import * as RelayClientRuntime from "./RelayClientRuntime.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CliState from "./CliState.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as CloudHttp from "./http.ts";

const disabled = () =>
  Effect.fail(
    new EnvironmentHttpForbiddenError({
      message: "The account relay is disabled. Configure a user-owned relay to enable it.",
    }),
  );

const layerDisabled = HttpApiBuilder.group(EnvironmentHttpApi, "connect", (handlers) =>
  Effect.succeed(
    handlers
      .handle("linkProof", disabled)
      .handle("relayConfig", disabled)
      .handle("linkState", disabled)
      .handle("unlink", disabled)
      .handle("preferences", disabled)
      .handle("health", disabled)
      .handle("mintCredential", disabled)
      .handle("t3MintCredential", disabled),
  ),
);

const layerStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const cloud = yield* CloudLink.CloudLink;
    const runtime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
    const server = yield* HttpServer.HttpServer;
    const config = yield* ServerConfig.ServerConfig;
    if (!("port" in server.address)) return;
    const host = config.host === "::1" || config.host === "::" ? "[::1]" : "127.0.0.1";
    const origin = `http://${host}:${server.address.port}`;
    yield* Activation.forkParked(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          cloud.releaseManagedTunnelOnShutdown().pipe(Effect.timeout("10 seconds"), Effect.ignore),
        );
        const recoveryLock = yield* Semaphore.make(1);
        const recoverySchedule = Schedule.exponential("1 second").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.seconds(30))),
          ),
          Schedule.jittered,
        );
        let lastRecovery = 0;
        yield* runtime.recoveryRequests.pipe(
          Stream.runForEach((request) =>
            recoveryLock.withPermits(1)(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const wait =
                  Duration.toMillis(MANAGED_TUNNEL_RECOVERY_COOLDOWN) - (now - lastRecovery);
                if (wait > 0) yield* Effect.sleep(wait);
                lastRecovery = yield* Clock.currentTimeMillis;
                yield* cloud
                  .recoverManagedTunnel(origin, request, { retryRuntimeFailures: true })
                  .pipe(
                    Effect.retry({
                      while: (error) =>
                        CloudLink.shouldRetryCloudLink(error) &&
                        error._tag !== "CloudLinkEndpointUnavailableError",
                      schedule: recoverySchedule,
                    }),
                    Effect.catchCause((cause) =>
                      Cause.hasInterrupts(cause)
                        ? Effect.interrupt
                        : Effect.logWarning(
                            "Failed to recover the configured account-relay tunnel",
                            { cause },
                          ),
                    ),
                  );
              }),
            ),
          ),
          Effect.forkScoped,
        );
        const wantsCliLink = yield* CliState.readCliDesiredCloudLink.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to read the desired account-relay link", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
        const desiredMode = wantsCliLink
          ? yield* CliState.readCliDesiredLinkMode.pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to read the desired account-relay link mode", {
                  cause,
                }).pipe(Effect.as("managed" as const)),
              ),
            )
          : null;
        const startedConfirmed =
          desiredMode === "publish_only"
            ? false
            : yield* cloud
                .startManagedTunnelIfOriginConfirmed(origin)
                .pipe(Effect.orElseSucceed(() => false));
        const startStored = cloud
          .startManagedTunnelIfOriginConfirmed(origin, { requireConfirmedOrigin: false })
          .pipe(Effect.ignore);
        const register = retryManagedTunnelRegistration(
          cloud.registerManagedTunnelRecovery(origin, { retryRuntimeFailures: true }),
          (error) =>
            CloudLink.shouldRetryCloudLink(error) &&
            error._tag !== "CloudLinkEndpointUnavailableError",
          startedConfirmed ? Effect.void : startStored,
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Failed to register the configured account-relay tunnel", {
                  cause,
                }).pipe(Effect.as({ status: "unavailable" as const })),
          ),
        );
        const registration =
          desiredMode === "publish_only" ? { status: "not_linked" as const } : yield* register;
        if (registration.status === "unavailable" && !startedConfirmed) yield* startStored;
        const action = managedTunnelStartupAction({ wantsCliLink, registration });
        if (action.action === "request_recovery") yield* runtime.requestRecovery(action.config);
        if (action.action === "reconcile_link") {
          const mode = yield* cloud.reconcileDesiredLinkIfStillDesired(origin).pipe(
            Effect.retry({
              while: CloudLink.shouldRetryCloudLink,
              schedule: recoverySchedule.pipe(Schedule.upTo({ duration: "10 minutes" })),
            }),
            Effect.catch((cause) =>
              Effect.logWarning("Failed to reconcile the desired account-relay link", {
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (mode === "managed") {
            const after = yield* register;
            if (after.status === "recovery_required") yield* runtime.requestRecovery(after.config);
          }
        }
      }),
    );
  }),
);

const layerRelay = Layer.mergeAll(CloudHttp.layer, layerStartup).pipe(
  Layer.provide(
    CloudLink.layer.pipe(
      Layer.provide(CliTokenManager.layer),
      Layer.provide(AgentAwarenessRelay.layer),
      Layer.provideMerge(
        ManagedEndpointRuntime.layer.pipe(Layer.provide(RelayClientRuntime.layer)),
      ),
    ),
  ),
);

// Choose before acquiring Clerk/relay services; an unconfigured server stays offline.
export const layer = Layer.unwrap(
  Config.Boolean("SUPACODE_CONNECT_RELAY_ENABLED").pipe(
    Config.withDefault(false),
    Effect.map((enabled) => (enabled ? layerRelay : layerDisabled)),
  ),
);
