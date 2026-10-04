import { describe, expect, it } from "vite-plus/test";
import { ExceptionReport } from "@supacode/contracts";
import * as Schema from "effect/Schema";
import {
  createExceptionLimiter,
  exceptionProperties,
  exceptionReport,
  exceptionReportFromSdk,
  sanitizeExceptionReport,
} from "./errorTracking.ts";

const isExceptionReport = Schema.is(ExceptionReport);

describe("error reporting privacy", () => {
  it("keeps source-map coordinates and chunk IDs without messages or host paths", () => {
    const error = new TypeError("token=private-secret and /Users/khoi/private.txt");
    error.stack =
      "TypeError: private-secret\n    at render (https://tailnet.example/pair#secret:25:4)\n    at execute (/Users/khoi/project/app.mjs:12:3)";
    const report = exceptionReport(error, "react", "abc123");
    expect(report).toBeDefined();
    const payload = JSON.stringify(exceptionProperties(report!));
    expect(payload).not.toMatch(/private-secret|Users|tailnet|pair#|token=/);
    expect(report?.exceptions[0]?.type).toBe("TypeError");
    expect(
      report?.exceptions[0]?.stacktrace.frames.some(
        (f) => f.filename === "app.mjs" && f.lineno === 12,
      ),
    ).toBe(true);
    const tagged = Object.assign(new Error("expected failure"), {
      _tag: "EnvironmentUnavailableError",
    });
    expect(exceptionReport(tagged, "rpc")).toBeDefined();
    expect(exceptionReport(new DOMException("cancel", "AbortError"), "uncaught")).toBeUndefined();
  });
  it("reconstructs received data and rejects unbounded wire reports", () => {
    const report: ExceptionReport = {
      release: "abc123",
      operation: "rpc",
      exceptions: [
        {
          type: "secret type",
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                filename: "https://host/private/app.js?token=secret",
                chunk_id: "12345678-abcd",
                lineno: 5,
                colno: 7,
              },
            ],
          },
        },
      ],
    };
    const safe = sanitizeExceptionReport(report);
    expect(safe.exceptions[0]?.stacktrace.frames[0]).toEqual({
      platform: "web:javascript",
      filename: "app.js",
      chunk_id: "12345678-abcd",
      lineno: 5,
      colno: 7,
    });
    expect(JSON.stringify(exceptionProperties(report))).not.toContain("secret");
    expect(isExceptionReport({ ...report, exceptions: Array(6).fill(report.exceptions[0]) })).toBe(
      false,
    );
    expect(exceptionProperties(report).$process_person_profile).toBe(false);
    expect(exceptionProperties(report).$geoip_disable).toBe(true);
  });
  it("normalizes oversized mobile SDK stacks while keeping the crash-side coordinates", () => {
    const frames = Array.from({ length: 75 }, (_, lineno) => ({
      platform: "hermes",
      filename: "/Users/khoi/app/index.js?token=private",
      lineno,
      colno: 4,
      chunk_id: "12345678-abcd",
      context_line: "private source",
    }));
    const sdkExceptions = Array.from({ length: 7 }, () => ({
      type: "TypeError",
      value: "private error",
      stacktrace: { type: "raw", frames },
      arbitrary: "private",
    }));
    const report = exceptionReportFromSdk(sdkExceptions, "abc123");
    expect(report).toBeDefined();
    expect(report?.exceptions).toHaveLength(5);
    expect(report?.exceptions[0]?.stacktrace.frames).toHaveLength(50);
    expect(report?.exceptions[0]?.stacktrace.frames.at(-1)?.lineno).toBe(74);
    expect(isExceptionReport(report)).toBe(true);
    expect(JSON.stringify(exceptionProperties(report!))).not.toMatch(
      /private|Users|context_line|token=/,
    );
  });
  it("bounds unique reports and resets duplicate suppression", () => {
    const allow = createExceptionLimiter();
    const report: ExceptionReport = {
      release: "abc123",
      operation: "react",
      exceptions: [{ type: "Error", stacktrace: { type: "raw", frames: [] } }],
    };
    expect(allow(report, 0)).toBe(true);
    expect(allow(report, 1)).toBe(false);
    for (let i = 1; i < 20; i++) expect(allow({ ...report, release: String(i) }, i)).toBe(true);
    expect(allow({ ...report, release: "other" }, 20)).toBe(false);
    expect(allow(report, 60_000)).toBe(true);
  });
});
