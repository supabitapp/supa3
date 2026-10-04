import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { exceptionReport } from "@supacode/shared/errorTracking";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ErrorTracking from "./ErrorTracking.ts";

function testLayer(events: string[], telemetry: boolean) {
  return ErrorTracking.layer.pipe(
    Layer.provide(
      Layer.succeed(
        AnalyticsService.AnalyticsService,
        AnalyticsService.AnalyticsService.of({
          record: (name) =>
            Effect.sync(() => {
              events.push(name);
            }),
          flush: Effect.void,
          recordFatalException: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SUPACODE_ERROR_TRACKING_ENABLED: true,
          SUPACODE_TELEMETRY_ENABLED: telemetry,
        }),
      ),
    ),
  );
}
it.effect("reports defects once while ignoring typed failures and interruption", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    yield* Effect.gen(function* () {
      const errors = yield* ErrorTracking.ErrorTracking;
      yield* errors.captureCause(Cause.fail({ _tag: "ExpectedError", message: "private" }), "rpc");
      yield* errors.captureCause(Cause.interrupt(), "rpc");
      const cause = Cause.die(new TypeError("private"));
      yield* errors.captureCause(cause, "rpc");
      yield* errors.captureCause(cause, "rpc");
      yield* errors.captureCause(
        Cause.die(Object.assign(new Error("private"), { _tag: "UnexpectedDefect" })),
        "rpc",
      );
    }).pipe(Effect.provide(testLayer(events, true)));
    assert.deepEqual(events, ["$exception", "$exception"]);
  }),
);
it.effect("the environment opt-out suppresses connected client and server reports", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    yield* Effect.gen(function* () {
      const errors = yield* ErrorTracking.ErrorTracking;
      yield* errors.captureCause(Cause.die(new Error("private")), "effect-worker");
      const input = exceptionReport(new Error("private"), "react", "abc123");
      if (input) yield* errors.report(input, "web");
    }).pipe(Effect.provide(testLayer(events, false)));
    assert.deepEqual(events, []);
  }),
);
