import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@supacode/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { formatCliCommand, resolveServerInstallation } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/supacode/dist/bin.mjs", "npx supacode serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\supacode\\dist\\bin.mjs",
      "npx supacode serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/supacode/dist/bin.mjs",
      "pnpm dlx supacode serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/supacode/dist/bin.mjs",
      "pnpm dlx supacode serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\supacode\\dist\\bin.mjs",
      "pnpm dlx supacode serve",
    ],
    ["/home/theo/.bun/install/cache/supacode@0.0.31/dist/bin.mjs", "bunx supacode serve"],
    ["/tmp/bunx-1000-supacode@latest/node_modules/supacode/dist/bin.mjs", "bunx supacode serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-supacode@latest\\node_modules\\supacode\\dist\\bin.mjs",
      "bunx supacode serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/supacode/dist/bin.mjs",
    "/home/theo/Code/work/supacode/apps/server/dist/bin.mjs",
    "/home/theo/.supacode/runtime/0.0.31/node_modules/supacode/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "supacode serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx supacode@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx supacode@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx supacode serve"],
    ["0.0.31", "npx supacode serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/supacode/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/supacode/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx supacode@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-supacode@latest/node_modules/supacode/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx supacode serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/supacode/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "supacode serve",
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/supacode/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@supabitapp/supacode-linux-x64/supacode", "npx"],
        ["pnpm/dlx/hash/node_modules/supacode/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/supacode/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcessArguments, ["node", entry]),
          Effect.provideService(HostProcessExecutablePath, entry),
          Effect.provideService(HostProcessIsExecutable, entry.endsWith("/supacode")),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/supacode");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/supacode");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"supacode","version":"0.0.45","bin":{"supacode":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessArguments, ["node", entry]),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated supacode command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcessPlatform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/supacode");
      const launcher = path.join(packageRoot, "bin/supacode.js");
      const entry = path.join(packageRoot, "node_modules/@supabitapp/supacode-linux-x64/supacode");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"supacode","version":"0.0.45","bin":{"supacode":"./bin/supacode.js"},"optionalDependencies":{"@supabitapp/supacode-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/supacode"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessExecutablePath, entry),
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        ["0.0.45", { kind: "npm-global", prefix }],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@supabitapp/supacode-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      for (const relative of [
        "project/node_modules/supacode/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".supacode/runtime/0.0.45/supacode",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcessArguments, ["node", entry]),
            Effect.provideService(HostProcessIsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
