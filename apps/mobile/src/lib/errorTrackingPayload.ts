import type { ExceptionReport } from "@supacode/contracts";
import { exceptionProperties } from "@supacode/shared/errorTracking";

/** Redact SDK exceptions before the native bridge receives them. */
export function mobileExceptionProperties(report: ExceptionReport, severity: unknown) {
  return {
    ...exceptionProperties(report),
    // The SDK hands fatal JS reports to native capture, which needs this marker for synchronous persistence.
    $exception_level: severity === "fatal" ? "fatal" : "error",
  };
}
