import type { ExceptionReport } from "@supacode/contracts";
import {
  createExceptionLimiter,
  errorTrackingRelease,
  exceptionProperties,
  exceptionReport,
} from "@supacode/shared/errorTracking";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { fatalRejections } from "./fatalRejections.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

export class ErrorTracking extends Context.Service<
  ErrorTracking,
  {
    readonly report: (report: ExceptionReport, surface: string) => Effect.Effect<void>;
    readonly captureCause: (
      cause: Cause.Cause<unknown>,
      operation: ExceptionReport["operation"],
    ) => Effect.Effect<void>;
  }
>()("supacode/telemetry/ErrorTracking") {}

export const make = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const enabled = yield* Config.Boolean("SUPACODE_ERROR_TRACKING_ENABLED").pipe(
    Config.withDefault(errorTrackingRelease !== ""),
  );
  const telemetryEnabled = yield* Config.Boolean("SUPACODE_TELEMETRY_ENABLED").pipe(
    Config.withDefault(true),
  );
  const allow = createExceptionLimiter();
  const clock = yield* Clock.Clock;
  const context = yield* Effect.context<never>();
  const report = Effect.fnUntraced(function* (input: ExceptionReport, surface: string) {
    if (!enabled || !telemetryEnabled || input.exceptions.length === 0) return;
    if (!allow(input, yield* Clock.currentTimeMillis)) return;
    yield* analytics.record("$exception", { ...exceptionProperties(input), surface });
  });
  const captureCause = Effect.fnUntraced(function* (
    cause: Cause.Cause<unknown>,
    operation: ExceptionReport["operation"],
  ) {
    for (const reason of cause.reasons) {
      if (!Cause.isDieReason(reason)) continue;
      const input = exceptionReport(reason.defect, operation);
      if (input) yield* report(input, "server");
    }
  });
  const monitor = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    const operation = origin === "unhandledRejection" ? "unhandled-rejection" : "uncaught";
    const input = exceptionReport(error, operation);
    if (!input || !allow(input, clock.currentTimeMillisUnsafe())) return;
    try {
      Effect.runSyncWith(context)(analytics.recordFatalException(input));
    } catch {
      /* Preserve Node fatal behavior. */
    }
  };
  const rejection = (error: unknown) =>
    monitor(
      error instanceof Error ? error : new Error("Unhandled promise rejection"),
      "unhandledRejection",
    );
  if (enabled && telemetryEnabled) {
    yield* Effect.acquireRelease(
      Effect.sync(() => fatalRejections.on("rejection", rejection)),
      () => Effect.sync(() => fatalRejections.off("rejection", rejection)),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("uncaughtExceptionMonitor", monitor)),
      () => Effect.sync(() => process.off("uncaughtExceptionMonitor", monitor)),
    );
  }
  return ErrorTracking.of({ report, captureCause });
});
export const layer = Layer.effect(ErrorTracking, make);
