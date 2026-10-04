import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { PostHog } from "posthog-react-native";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { createExceptionLimiter, exceptionReportFromSdk } from "@supacode/shared/errorTracking";
import { mobilePreferencesAtom } from "../state/preferences";
import { mobileExceptionProperties } from "./errorTrackingPayload";

const release = process.env.EXPO_PUBLIC_POSTHOG_RELEASE ?? "";
const allow = createExceptionLimiter();
let enabled = false;
let client: PostHog | undefined;

function initialize() {
  return new PostHog("phc_mpkbs8jxUDhRkrsvAPZEpzVxykW3Ce2HEPGPrfhgSrLC", {
    // gitleaks:allow
    host: "https://us.i.posthog.com",
    captureAppLifecycleEvents: false,
    enableSessionReplay: false,
    preloadFeatureFlags: false,
    disableRemoteFeatureFlags: true,
    disableSurveys: true,
    personProfiles: "never",
    capturePushNotificationSubscriptions: false,
    capturePushNotificationOpened: false,
    rageClickConfig: { enabled: false },
    flushAt: 10,
    maxQueueSize: 100,
    flushInterval: 10_000,
    errorTracking: {
      autocapture: {
        uncaughtExceptions: true,
        unhandledRejections: true,
        console: [],
        nativeCrashes: true,
        androidNdkCrashes: false,
      },
      exceptionSteps: { enabled: false },
    },
    before_send: (event) => {
      if (!enabled || !event || event.event !== "$exception") return null;
      const report = exceptionReportFromSdk(event.properties?.$exception_list, release);
      if (!report || !allow(report, performance.now())) return null;
      return {
        ...event,
        properties: {
          ...mobileExceptionProperties(report, event.properties?.$exception_level),
          ...(event.properties?.distinct_id !== undefined
            ? { distinct_id: event.properties.distinct_id }
            : {}),
          surface: "mobile",
          clientOs: Platform.OS,
          clientAppVersion: Constants.expoConfig?.version ?? "unknown",
        },
      };
    },
  });
}

/** Start only after device preferences load. An opt-out is enforced before asynchronous SDK work. */
export function ErrorTrackingCoordinator() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const nextEnabled =
    ready && preferences.value.errorReportingEnabled !== false && !!release && !__DEV__;
  useEffect(() => {
    enabled = nextEnabled;
    if (!release || __DEV__ || !ready) return;
    if (!client && enabled) client = initialize();
    if (client) void (enabled ? client.optIn() : client.optOut()).catch(() => undefined);
    return () => {
      enabled = false;
    };
  }, [nextEnabled, ready]);
  return null;
}

export function reportMobileException(error: unknown) {
  if (enabled) {
    try {
      client?.captureException(error);
    } catch {
      /* Error reporting is best effort. */
    }
  }
}
