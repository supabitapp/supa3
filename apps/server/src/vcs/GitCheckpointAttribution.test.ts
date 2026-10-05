import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  VcsProcessOutputLimitError,
  VcsProcessTimeoutError,
} from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitCheckpointAttribution from "./GitCheckpointAttribution.ts";
import * as VcsProcess from "./VcsProcess.ts";

const input = {
  cwd: "/repo",
  fromCheckpointRef: CheckpointRef.make("refs/test/from"),
  toCheckpointRef: CheckpointRef.make("refs/test/to"),
  runStartedAtMs: 1000000,
};
const from = "a".repeat(40);
const to = "b".repeat(40);
const metadata = (head: string) =>
  `supacode checkpoint ref=refs/test/from head=${from} branch=refs/heads/main\n\0\nsupacode checkpoint ref=refs/test/to head=${head} branch=refs/heads/feature\n\0\n`;
const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect("unchanged HEAD does not walk history or read additional diffs", () => {
  const calls: string[][] = [];
  return Effect.gen(function* () {
    assert.isUndefined(yield* GitCheckpointAttribution.getCheckpointGitUpdate(input));
    assert.equal(calls.length, 1);
  }).pipe(
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (request) => {
          calls.push([...request.args]);
          return Effect.succeed(output(metadata(from)));
        },
      }),
    ),
  );
});

it.effect.each(["commits", "invalid-utf8", "invalid-raw", "output-limit", "timeout"] as const)(
  "fails open on %s",
  (failure) => {
    let calls = 0;
    return Effect.gen(function* () {
      assert.isUndefined(yield* GitCheckpointAttribution.getCheckpointGitUpdate(input));
    }).pipe(
      Effect.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (request) => {
            calls += 1;
            if (calls === 1) return Effect.succeed(output(metadata(to)));
            assert.equal(request.outputMode, "error");
            if (failure === "output-limit")
              return Effect.fail(
                new VcsProcessOutputLimitError({
                  operation: "test",
                  command: "git",
                  cwd: input.cwd,
                  stream: "stdout",
                  maxBytes: 16 * 1024 * 1024,
                  observedBytes: 16 * 1024 * 1024 + 1,
                }),
              );
            if (failure === "timeout")
              return Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "test",
                  command: "git",
                  cwd: input.cwd,
                  timeoutMs: 10000,
                }),
              );
            if (failure === "invalid-utf8")
              return Effect.succeed({ ...output(""), stdoutInvalidUtf8: true });
            if (failure === "commits")
              return Effect.succeed(
                output(Array.from({ length: 513 }, () => `${to} 1000`).join("\n")),
              );
            return Effect.succeed(output(calls === 2 ? "" : "malformed raw output"));
          },
        }),
      ),
    );
  },
);

it.effect("bounds the whole attribution operation while waiting for a process slot", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const fiber = yield* GitCheckpointAttribution.getCheckpointGitUpdate(input).pipe(
      Effect.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(10001);
    assert.isUndefined(yield* Fiber.join(fiber));
  }),
);
