import * as Schema from "effect/Schema";

const ShortString = Schema.String.check(Schema.isMaxLength(128));
export const ExceptionStackFrame = Schema.Struct({
  platform: Schema.Literals(["node:javascript", "web:javascript", "hermes"]),
  filename: Schema.optionalKey(ShortString),
  function: Schema.optionalKey(ShortString),
  lineno: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 })),
  ),
  colno: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 })),
  ),
  chunk_id: Schema.optionalKey(ShortString),
});

export const ExceptionReport = Schema.Struct({
  exceptions: Schema.Array(
    Schema.Struct({
      type: ShortString,
      stacktrace: Schema.Struct({
        type: Schema.Literal("raw"),
        frames: Schema.Array(ExceptionStackFrame).check(Schema.isMaxLength(50)),
      }),
    }),
  ).check(Schema.isMaxLength(5)),
  operation: Schema.Literals([
    "react",
    "router",
    "uncaught",
    "unhandled-rejection",
    "rpc",
    "effect-worker",
    "desktop-main",
    "renderer-gone",
    "child-process-gone",
    "preload",
  ]),
  release: Schema.String.check(Schema.isMaxLength(80)),
  releaseId: Schema.optionalKey(ShortString),
  processReason: Schema.optionalKey(
    Schema.Literals(["crashed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"]),
  ),
});
export type ExceptionReport = typeof ExceptionReport.Type;
