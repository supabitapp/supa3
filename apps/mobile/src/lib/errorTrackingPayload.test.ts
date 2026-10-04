import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { exceptionReportFromSdk } from "@supacode/shared/errorTracking";
import { mobileExceptionProperties } from "./errorTrackingPayload";

const require = NodeModule.createRequire(import.meta.url);
// Exercise the installed SDK's private handoff builder without loading React Native.
const { buildFatalExceptionPayload } = require(
  NodePath.join(
    NodePath.dirname(require.resolve("posthog-react-native")),
    "error-tracking/fatal-payload.js",
  ),
) as {
  buildFatalExceptionPayload: (input: {
    timestamp: string;
    distinctId: string;
    properties: ReturnType<typeof mobileExceptionProperties>;
  }) => { properties: ReturnType<typeof mobileExceptionProperties> };
};

const sdkExceptions = [
  {
    type: "TypeError",
    value: "private exception message",
    stacktrace: {
      type: "raw",
      frames: [
        {
          platform: "hermes",
          filename: "/Users/khoi/private/index.js?token=private",
          lineno: 42,
          colno: 7,
          chunk_id: "12345678-abcd",
          context_line: "private source",
        },
      ],
    },
  },
];

describe("mobile exception payloads", () => {
  it("keeps fatal JS crashes fatal through redaction and the SDK native handoff", () => {
    const report = exceptionReportFromSdk(sdkExceptions, "abc123");
    expect(report).toBeDefined();
    const payload = buildFatalExceptionPayload({
      timestamp: "2026-10-04T12:00:00.000Z",
      distinctId: "anonymous-installation",
      properties: mobileExceptionProperties(report!, "fatal"),
    });
    expect(payload.properties.$exception_level).toBe("fatal");
    expect(payload.properties.$exception_list[0]?.stacktrace.frames[0]).toEqual({
      platform: "hermes",
      filename: "index.js",
      lineno: 42,
      colno: 7,
      chunk_id: "12345678-abcd",
    });
    expect(JSON.stringify(payload)).not.toMatch(/private|Users|context_line|token=/);
  });

  it.each(["error", "warning", "fatal-private", undefined, 123])(
    "normalizes non-fatal or unexpected severity %s to error",
    (severity) => {
      const report = exceptionReportFromSdk(sdkExceptions, "abc123");
      expect(mobileExceptionProperties(report!, severity).$exception_level).toBe("error");
    },
  );
});
