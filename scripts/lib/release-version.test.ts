import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  prepareNextReleaseTarget,
  resolveCalendarReleaseTarget,
  validateCalendarReleaseVersion,
} from "./release-version.ts";

it.effect("previews the prepared patch or feature target without another bump", () =>
  Effect.gen(function* () {
    for (const version of ["26.0.0", "26.0.1", "26.1.0", "26.10.0"]) {
      assert.equal(yield* resolveCalendarReleaseTarget(version, "20261004"), version);
    }
  }),
);

it.effect("rolls the target forward using the actual UTC release year", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveCalendarReleaseTarget("26.9.8", "20270101"), "27.0.0");
    assert.equal(yield* resolveCalendarReleaseTarget("26.9.8", "20261231"), "26.9.8");
    const error = yield* resolveCalendarReleaseTarget("27.0.0", "20261231").pipe(Effect.flip);
    assert.include(error.message, "future release year");
  }),
);

it.effect("rejects malformed cores and invalid release dates", () =>
  Effect.gen(function* () {
    for (const version of [
      "26",
      "26.0",
      "026.0.0",
      "26.01.0",
      "26.0.0-preview.1",
      "26.0.0+build.1",
      "26.0.9007199254740992",
    ]) {
      const error = yield* validateCalendarReleaseVersion(version, "20261004").pipe(Effect.flip);
      assert.equal(error._tag, "CalendarReleaseVersionError");
    }
    for (const date of ["20260229", "20261301", "20261000", "2026-10-04", "invalid", "19991231"]) {
      const error = yield* resolveCalendarReleaseTarget("26.0.0", date).pipe(Effect.flip);
      assert.equal(error._tag, "CalendarReleaseVersionError");
    }
    assert.equal(yield* resolveCalendarReleaseTarget("26.0.0", "20280229"), "28.0.0");
  }),
);

it.effect("requires current-year versions for new publication", () =>
  Effect.gen(function* () {
    assert.equal(yield* validateCalendarReleaseVersion("26.0.0", "20261004"), "26.0.0");
    const error = yield* validateCalendarReleaseVersion("26.0.1", "20270101").pipe(Effect.flip);
    assert.include(error.message, "Expected release year 27");
  }),
);

it.effect("prepares the next patch while retaining a higher target", () =>
  Effect.gen(function* () {
    assert.equal(yield* prepareNextReleaseTarget("26.0.0", "26.0.0"), "26.0.1");
    assert.equal(yield* prepareNextReleaseTarget("26.0.1", "26.0.0"), "26.0.1");
    assert.equal(yield* prepareNextReleaseTarget("26.1.0", "26.0.0"), "26.1.0");
    assert.equal(yield* prepareNextReleaseTarget("26.10.0", "26.9.0"), "26.10.0");
    assert.equal(yield* prepareNextReleaseTarget("27.0.0", "26.9.0"), "27.0.0");
    assert.equal(yield* prepareNextReleaseTarget("26.9.0", "27.0.0"), "27.0.1");
  }),
);
