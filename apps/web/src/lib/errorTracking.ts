import { WS_METHODS } from "@supacode/contracts";
import { createEnvironmentRpcCommand } from "@supacode/client-runtime/state/runtime";
import {
  createExceptionLimiter,
  errorTrackingRelease,
  exceptionReport,
} from "@supacode/shared/errorTracking";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readActiveEnvironmentId } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { ensureClientSettingsHydrated, getClientSettings } from "../hooks/useSettings";

const report = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "client-error-report",
  tag: WS_METHODS.serverReportException,
});
const allow = createExceptionLimiter();

export async function reportClientException(
  error: unknown,
  operation: Parameters<typeof exceptionReport>[1],
) {
  if (!errorTrackingRelease) return;
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "_tag") === "string")
    return;
  const environmentId = readActiveEnvironmentId() ?? appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return;
  const input = exceptionReport(error, operation);
  if (!input || !allow(input, performance.now())) return;
  try {
    await ensureClientSettingsHydrated();
    if (!getClientSettings().errorReportingEnabled) return;
    await report.run(appAtomRegistry, { environmentId, input });
  } catch {
    /* Reporting must never become another uncaught error. */
  }
}

export function installClientErrorTracking() {
  const onError = (event: ErrorEvent) => {
    if (event.error) void reportClientException(event.error, "uncaught");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void reportClientException(event.reason, "unhandled-rejection");
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
