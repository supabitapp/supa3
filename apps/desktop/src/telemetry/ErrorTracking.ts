import type { ExceptionReport } from "@supacode/contracts";
import * as Electron from "electron";
import {
  createExceptionLimiter,
  errorTrackingRelease,
  exceptionReport,
} from "@supacode/shared/errorTracking";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (
      !errorTrackingRelease ||
      process.env.SUPACODE_TELEMETRY_ENABLED === "false" ||
      process.env.SUPACODE_ERROR_TRACKING_ENABLED === "false"
    )
      return;
    const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    const context = yield* Effect.context<never>();
    const allow = createExceptionLimiter();
    const capture = (
      error: unknown,
      operation: Parameters<typeof exceptionReport>[1],
      processReason?: ExceptionReport["processReason"],
    ) => {
      const normalized = exceptionReport(error, operation);
      if (!normalized) return;
      const report = { ...normalized, ...(processReason ? { processReason } : {}) };
      Effect.runForkWith(context)(
        Effect.gen(function* () {
          const preferences = yield* settings.get;
          if (Option.isSome(preferences) && !preferences.value.errorReportingEnabled) return;
          if (!allow(report, yield* Clock.currentTimeMillis)) return;
          yield* publisher.reportException({ version: 1, type: "desktopException", report });
        }).pipe(Effect.ignore),
      );
    };
    const monitor = (error: Error) => capture(error, "desktop-main");
    const failureReasons = [
      "crashed",
      "oom",
      "abnormal-exit",
      "launch-failed",
      "integrity-failure",
    ] as const;
    const reportProcessFailure = (
      reason: string,
      operation: "renderer-gone" | "child-process-gone",
    ) => {
      const failure = failureReasons.find((value) => value === reason);
      if (failure) capture(new Error("Desktop process failed"), operation, failure);
    };
    const rendererGone = (
      _event: Electron.Event,
      _contents: Electron.WebContents,
      details: Electron.RenderProcessGoneDetails,
    ) => {
      reportProcessFailure(details.reason, "renderer-gone");
    };
    const childGone = (_event: Electron.Event, details: Electron.Details) => {
      reportProcessFailure(details.reason, "child-process-gone");
    };
    const observed = new Set<Electron.WebContents>();
    const preloadError = (_event: Electron.Event, _path: string, error: Error) =>
      capture(error, "preload");
    const observeContents = (
      _event: Electron.Event | undefined,
      contents: Electron.WebContents,
    ) => {
      observed.add(contents);
      contents.on("preload-error", preloadError);
      contents.once("destroyed", () => observed.delete(contents));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        Electron.app.on("web-contents-created", observeContents);
        for (const contents of Electron.webContents.getAllWebContents())
          observeContents(undefined, contents);
        process.on("uncaughtExceptionMonitor", monitor);
        Electron.app.on("render-process-gone", rendererGone);
        Electron.app.on("child-process-gone", childGone);
      }),
      () =>
        Effect.sync(() => {
          Electron.app.off("web-contents-created", observeContents);
          for (const contents of observed)
            if (!contents.isDestroyed()) contents.off("preload-error", preloadError);
          process.off("uncaughtExceptionMonitor", monitor);
          Electron.app.off("render-process-gone", rendererGone);
          Electron.app.off("child-process-gone", childGone);
        }),
    );
  }),
);
