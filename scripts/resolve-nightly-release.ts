#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  CalendarReleaseVersionError,
  resolveCalendarReleaseTarget,
  validateCalendarReleaseVersion,
} from "./lib/release-version.ts";
import { readReleasePackageVersion } from "./update-release-package-versions.ts";

export interface ReleaseMetadata {
  readonly baseVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
}

const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));
const RunNumberSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i));

export class ReleaseMetadataGitHubOutputConfigError extends Schema.TaggedError<ReleaseMetadataGitHubOutputConfigError>()(
  "ReleaseMetadataGitHubOutputConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve the GITHUB_OUTPUT path for nightly release metadata.";
  }
}

export class ReleaseMetadataGitHubOutputAppendError extends Schema.TaggedError<ReleaseMetadataGitHubOutputAppendError>()(
  "ReleaseMetadataGitHubOutputAppendError",
  {
    outputPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append nightly release metadata to ${this.outputPath}.`;
  }
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

/** Prerelease trains that share nightly's date-and-run versioning. */
export const PrereleaseChannel = Schema.Literals(["nightly", "preview"]);
export type PrereleaseChannel = typeof PrereleaseChannel.Type;

// The preview label is deliberately loud: the releases page is the one place
// a preview build can be found, and its name is the first thing a visitor
// reads before the warning in the body.
const CHANNEL_RELEASE_LABELS: Record<PrereleaseChannel, string> = {
  nightly: "Nightly",
  preview: "Preview (maintainer test build, do not install)",
};

export const resolveReleaseMetadata = (
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string,
  channel: PrereleaseChannel = "nightly",
) => {
  const shortSha = sha.slice(0, 12);
  const version = `${baseVersion}-${channel}.${date}.${runNumber}`;
  return {
    baseVersion,
    version,
    tag: `v${version}`,
    name: `Supacode ${CHANNEL_RELEASE_LABELS[channel]} ${version} (${shortSha})`,
    shortSha,
  };
};

export const readPreparedReleaseVersion = Effect.fn("readPreparedReleaseVersion")(function* (
  rootDir: string | undefined,
) {
  const path = yield* Path.Path;
  const workspaceRoot = rootDir ? path.resolve(rootDir) : yield* RepoRoot;
  return yield* readReleasePackageVersion(workspaceRoot);
});

export const resolveStableReleaseMetadata = Effect.fnUntraced(function* (
  version: string,
  date: string,
  sha: string,
  nightlyVersion: string | undefined,
) {
  const core = yield* validateCalendarReleaseVersion(version.replace(/^v/, ""), date);
  if (nightlyVersion !== undefined) {
    const candidate = yield* validateCalendarReleaseVersion(nightlyVersion, date);
    if (candidate !== core) {
      return yield* new CalendarReleaseVersionError({
        version,
        reason: `The verified nightly previews ${candidate}. Prepare and verify a matching nightly before promoting ${core}.`,
      });
    }
  }
  return {
    baseVersion: core,
    version: core,
    tag: `v${core}`,
    name: `Supacode v${core}`,
    shortSha: sha.slice(0, 12),
  };
});

export const writeReleaseMetadataOutput = Effect.fn("writeReleaseMetadataOutput")(function* (
  metadata: ReleaseMetadata,
  writeGithubOutput: boolean,
  channel: "stable" | PrereleaseChannel = "nightly",
) {
  const fs = yield* FileSystem.FileSystem;

  const entries = [
    ["base_version", metadata.baseVersion],
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
    ["short_sha", metadata.shortSha],
    ["release_channel", channel],
    ["cli_dist_tag", channel === "stable" ? "latest" : channel],
    ["is_prerelease", channel === "stable" ? "false" : "true"],
    ["make_latest", channel === "stable" ? "true" : "false"],
  ] as const;

  if (writeGithubOutput) {
    const githubOutputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseMetadataGitHubOutputConfigError({
            cause,
          }),
      ),
    );
    const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
    yield* fs.writeFileString(githubOutputPath, serialized, { flag: "a" }).pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseMetadataGitHubOutputAppendError({
            outputPath: githubOutputPath,
            cause,
          }),
      ),
    );
  } else {
    for (const [key, value] of entries) {
      yield* Console.log(`${key}=${value}`);
    }
  }
});

const command = Command.make(
  "resolve-nightly-release",
  {
    date: Flag.String("date").pipe(
      Flag.withSchema(DateSchema),
      Flag.withDescription("Nightly build date in YYYYMMDD."),
    ),
    runNumber: Flag.String("run-number").pipe(
      Flag.withSchema(RunNumberSchema),
      Flag.withDescription("GitHub Actions run number."),
    ),
    sha: Flag.String("sha").pipe(
      Flag.withSchema(ShaSchema),
      Flag.withDescription("Commit sha for the nightly build."),
    ),
    channel: Flag.Literals("channel", ["stable", ...PrereleaseChannel.literals]).pipe(
      Flag.withDescription("Release channel whose metadata to resolve."),
      Flag.withDefault("nightly" as const),
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription("Workspace root used to resolve apps/desktop/package.json."),
      Flag.optional,
    ),
    version: Flag.String("version").pipe(
      Flag.withDescription("Stable release version or tag."),
      Flag.optional,
    ),
    nightlyVersion: Flag.String("nightly-version").pipe(
      Flag.withDescription("Stable core of the nightly being promoted."),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({
    date,
    runNumber,
    sha,
    channel,
    githubOutput,
    root,
    version,
    nightlyVersion,
  }) {
    const prepared = yield* readPreparedReleaseVersion(Option.getOrUndefined(root));
    const metadata =
      channel === "stable"
        ? yield* resolveStableReleaseMetadata(
            Option.getOrElse(version, () => prepared),
            date,
            sha,
            Option.getOrUndefined(nightlyVersion),
          )
        : resolveReleaseMetadata(
            yield* resolveCalendarReleaseTarget(prepared, date),
            date,
            runNumber,
            sha,
            channel,
          );
    yield* writeReleaseMetadataOutput(metadata, githubOutput, channel);
  }),
).pipe(Command.withDescription("Resolve calendar release version metadata."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
