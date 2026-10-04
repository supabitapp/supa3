import {
  ErrorCoercer,
  ErrorPropertiesBuilder,
  createDefaultStackParser,
  getInjectedReleaseId,
} from "@posthog/core/error-tracking";
import { ExceptionReport, ExceptionStackFrame } from "@supacode/contracts";

import * as Schema from "effect/Schema";

declare const __SUPACODE_ERROR_TRACKING_RELEASE__: string;
export const errorTrackingRelease =
  typeof __SUPACODE_ERROR_TRACKING_RELEASE__ === "undefined"
    ? ""
    : __SUPACODE_ERROR_TRACKING_RELEASE__;

const builder = new ErrorPropertiesBuilder([new ErrorCoercer()], createDefaultStackParser());
const safeTypes = new Set([
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

const SdkFrame = Schema.Struct({
  ...ExceptionStackFrame.fields,
  filename: Schema.optionalKey(Schema.String),
  function: Schema.optionalKey(Schema.String),
  chunk_id: Schema.optionalKey(Schema.String),
});
const decodeSdkExceptions = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      stacktrace: Schema.optionalKey(Schema.Struct({ frames: Schema.Array(SdkFrame) })),
    }),
  ),
);

/** SDK stacks are unbounded and can contain paths; normalize before applying the wire limits. */
export function exceptionReportFromSdk(
  exceptionList: unknown,
  release: string,
): ExceptionReport | undefined {
  const decoded = decodeSdkExceptions(exceptionList);
  if (decoded._tag === "None" || decoded.value.length === 0) return;
  return sanitizeExceptionReport({
    operation: "uncaught",
    release,
    exceptions: decoded.value.map((exception) => ({
      type: exception.type ?? "Error",
      stacktrace: { type: "raw", frames: exception.stacktrace?.frames ?? [] },
    })),
  });
}

/** Preserve chunk IDs and coordinates, discard messages, paths, source context and custom fields. */
export function sanitizeExceptionReport(report: ExceptionReport): ExceptionReport {
  return {
    operation: report.operation,
    release: /^[a-zA-Z0-9._-]{1,80}$/.test(report.release) ? report.release : "unknown",
    ...(report.releaseId && /^[a-zA-Z0-9-]{1,128}$/.test(report.releaseId)
      ? { releaseId: report.releaseId }
      : {}),
    ...(report.processReason &&
    ["crashed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"].includes(
      report.processReason,
    )
      ? { processReason: report.processReason }
      : {}),
    exceptions: report.exceptions.slice(0, 5).map((exception) => ({
      type: safeTypes.has(exception.type) ? exception.type : "Error",
      stacktrace: {
        type: "raw",
        frames: exception.stacktrace.frames.slice(-50).map((frame) => {
          const filename = frame.filename?.split(/[?#]/, 1)[0]?.split(/[\\/]/).at(-1);
          return {
            platform: frame.platform,
            ...(filename &&
            filename.length <= 128 &&
            /^[a-zA-Z0-9_.-]+\.(?:[cm]?js|hbc)$/.test(filename)
              ? { filename }
              : {}),
            ...(frame.function && /^[a-zA-Z0-9_.$<> [\]]{1,128}$/.test(frame.function)
              ? { function: frame.function }
              : {}),
            ...(frame.lineno !== undefined ? { lineno: frame.lineno } : {}),
            ...(frame.colno !== undefined ? { colno: frame.colno } : {}),
            ...(frame.chunk_id && /^[a-zA-Z0-9-]{1,128}$/.test(frame.chunk_id)
              ? { chunk_id: frame.chunk_id }
              : {}),
          };
        }),
      },
    })),
  };
}

/** Normalize with PostHog's parser before redaction so source-map identities survive. */
export function exceptionReport(
  error: unknown,
  operation: ExceptionReport["operation"],
  release = errorTrackingRelease,
): ExceptionReport | undefined {
  try {
    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        /Failed to fetch dynamically imported module|Loading chunk .* failed/.test(error.message))
    )
      return;
    const properties = builder.buildFromUnknown(error);
    const releaseId = getInjectedReleaseId();
    return sanitizeExceptionReport({
      operation,
      release,
      ...(releaseId ? { releaseId } : {}),
      exceptions: properties.$exception_list.map((exception) => ({
        type: exception.type ?? "Error",
        stacktrace: { type: "raw", frames: exception.stacktrace?.frames ?? [] },
      })),
    });
  } catch {
    return;
  }
}

export function exceptionProperties(report: ExceptionReport) {
  const safe = sanitizeExceptionReport(report);
  return {
    $exception_list: safe.exceptions.map((exception) => ({
      ...exception,
      stacktrace: {
        type: "raw",
        frames: exception.stacktrace.frames.map((frame) => ({ ...frame })),
      },
      value: `${exception.type} (${safe.operation})`,
      mechanism: {
        handled: !["uncaught", "unhandled-rejection"].includes(safe.operation),
        type: safe.operation,
      },
    })),
    $exception_level: "error",
    ...(safe.releaseId ? { $release: safe.releaseId } : {}),
    release: safe.release,
    operation: safe.operation,
    ...(safe.processReason ? { processReason: safe.processReason } : {}),
    $process_person_profile: false,
    $geoip_disable: true,
  };
}

/** Bound duplicate fingerprints and total volume, even when every failure is unique. */
export function createExceptionLimiter() {
  let windowStart = 0;
  let total = 0;
  const fingerprints = new Set<string>();
  return (report: ExceptionReport, now: number) => {
    if (now - windowStart >= 60_000) {
      windowStart = now;
      total = 0;
      fingerprints.clear();
    }
    const fingerprint = JSON.stringify([report.release, report.processReason, report.exceptions]);
    if (total >= 20 || fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    total += 1;
    return true;
  };
}
