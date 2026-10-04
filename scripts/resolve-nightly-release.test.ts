import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  readPreparedReleaseVersion,
  resolveReleaseMetadata,
  resolveStableReleaseMetadata,
  writeReleaseMetadataOutput,
} from "./resolve-nightly-release.ts";

it.effect("promotes a matching calendar nightly or explicit tag", () =>
  Effect.gen(function* () {
    const metadata = yield* resolveStableReleaseMetadata(
      "26.1.0",
      "20261004",
      "abcdef1234567890",
      "26.1.0",
    );
    assert.equal(metadata.version, "26.1.0");
    assert.equal(metadata.tag, "v26.1.0");
    assert.equal(
      (yield* resolveStableReleaseMetadata("v26.0.0", "20261004", "abcdef1234567890", undefined))
        .version,
      "26.0.0",
    );
  }),
);

it.effect("rejects a mismatched candidate and December promotion during January", () =>
  Effect.gen(function* () {
    const mismatch = yield* resolveStableReleaseMetadata(
      "26.1.0",
      "20261004",
      "abcdef1234567890",
      "26.0.1",
    ).pipe(Effect.flip);
    assert.include(mismatch.message, "verified nightly previews 26.0.1");
    const rollover = yield* resolveStableReleaseMetadata(
      "27.0.0",
      "20270101",
      "abcdef1234567890",
      "26.0.1",
    ).pipe(Effect.flip);
    assert.include(rollover.message, "Expected release year 27");
  }),
);

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(resolveReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"), {
    baseVersion: "9.9.10",
    version: "9.9.10-nightly.20260413.321",
    tag: "v9.9.10-nightly.20260413.321",
    name: "Supacode Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    shortSha: "abcdef123456",
  });
});

it("derives preview metadata under its own prerelease identifier", () => {
  assert.deepStrictEqual(
    resolveReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890", "preview"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-preview.20260413.321",
      tag: "v9.9.10-preview.20260413.321",
      name: "Supacode Preview (maintainer test build, do not install) 9.9.10-preview.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

it.effect("preserves the GITHUB_OUTPUT configuration cause", () => {
  const metadata = resolveReleaseMetadata("1.2.4", "20260620", 42, "abcdef1234567890");
  const configCause = new ConfigProvider.SourceError({ message: "environment unavailable" });

  return Effect.gen(function* () {
    const configError = yield* writeReleaseMetadataOutput(metadata, true).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make(() => Effect.fail(configCause)),
      ),
      Effect.flip,
    );

    if (configError._tag !== "ReleaseMetadataGitHubOutputConfigError") {
      return assert.fail(`Unexpected error: ${configError._tag}`);
    }
    assert.instanceOf(configError.cause, Config.ConfigError);
    assert.strictEqual(configError.cause.cause, configCause);
    assert.notInclude(configError.message, configCause.message);
  });
});

it.layer(NodeServices.layer)("readPreparedReleaseVersion", (it) => {
  it.effect("preserves release package read context and its platform cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-read-",
      });
      const packageJsonPath = path.join(rootDir, "apps/server/package.json");

      const error = yield* readPreparedReleaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "ReleasePackageManifestError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.filePath, packageJsonPath);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );

  it.effect("preserves release package decode context and its schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-decode-",
      });
      const packageJsonPath = path.join(rootDir, "apps/server/package.json");
      yield* fs.makeDirectory(path.dirname(packageJsonPath), { recursive: true });
      yield* fs.writeFileString(packageJsonPath, "{");

      const error = yield* readPreparedReleaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "ReleasePackageManifestError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "decode");
      assert.equal(error.filePath, packageJsonPath);
      assert.ok(error.cause !== undefined);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );
});
