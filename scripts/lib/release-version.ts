import { compareSemverVersions } from "@supacode/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class CalendarReleaseVersionError extends Schema.TaggedError<CalendarReleaseVersionError>()(
  "CalendarReleaseVersionError",
  {
    version: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid release version '${this.version}': ${this.reason}`;
  }
}

const ReleaseCore = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  Schema.makeFilter((version) =>
    version.split(".").every((part) => Number.isSafeInteger(Number(part))),
  ),
);

const decodeReleaseCoreSchema = Schema.decodeEffect(ReleaseCore);
const decodeReleaseCore = (version: string) =>
  decodeReleaseCoreSchema(version).pipe(
    Effect.mapError(
      (cause) =>
        new CalendarReleaseVersionError({
          version,
          reason: "Expected three integers without leading zeros or a prerelease suffix.",
          cause,
        }),
    ),
  );

const releaseYear = Effect.fnUntraced(function* (date: string) {
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = DateTime.make(`${isoDate}T00:00:00Z`);
  if (
    !/^\d{8}$/.test(date) ||
    Option.isNone(parsed) ||
    DateTime.formatIsoDateUtc(parsed.value) !== isoDate
  ) {
    return yield* new CalendarReleaseVersionError({
      version: date,
      reason: "Expected a valid YYYYMMDD release date.",
    });
  }
  const year = DateTime.getPartUtc(parsed.value, "year") - 2000;
  if (year < 0) {
    return yield* new CalendarReleaseVersionError({
      version: date,
      reason: "The release year must be 2000 or later.",
    });
  }
  return year;
});

/** A stored next-release target rolls forward only when the UTC year changes. */
export const resolveCalendarReleaseTarget = Effect.fnUntraced(function* (
  version: string,
  date: string,
) {
  const core = yield* decodeReleaseCore(version);
  const year = yield* releaseYear(date);
  const preparedYear = Number(core.split(".")[0]);
  if (preparedYear > year) {
    return yield* new CalendarReleaseVersionError({
      version,
      reason: `The target belongs to a future release year; expected ${year}.`,
    });
  }
  return preparedYear < year ? `${year}.0.0` : core;
});

/** Validates a new public release, without restricting installation of older versions. */
export const validateCalendarReleaseVersion = Effect.fnUntraced(function* (
  version: string,
  date: string,
) {
  const core = yield* decodeReleaseCore(version);
  const year = yield* releaseYear(date);
  if (Number(core.split(".")[0]) !== year) {
    return yield* new CalendarReleaseVersionError({
      version,
      reason: `Expected release year ${year}.`,
    });
  }
  return core;
});

/** Stable finalization preserves a higher feature target already prepared on main. */
export const prepareNextReleaseTarget = Effect.fnUntraced(function* (
  currentVersion: string,
  releasedVersion: string,
) {
  const current = yield* decodeReleaseCore(currentVersion);
  const released = yield* decodeReleaseCore(releasedVersion);
  const [year, minor, patch] = released.split(".");
  const next = yield* decodeReleaseCore(`${year}.${minor}.${Number(patch) + 1}`);
  return compareSemverVersions(current, next) > 0 ? current : next;
});
