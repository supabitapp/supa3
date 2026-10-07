// @effect-diagnostics nodeBuiltinImport:off - Directory junctions keep symlink fixtures usable on Windows without elevation.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readInstalledPackages } from "./installed-packages.ts";

const writePackage = Effect.fn("test.writePackage")(function* (
  directory: string,
  manifest: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "package.json"), JSON.stringify(manifest));
});

const linkPackage = Effect.fn("test.linkPackage")(function* (target: string, link: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(link), { recursive: true });
  yield* Effect.tryPromise(() => NodeFSP.symlink(target, link, "junction"));
});

it.layer(NodeServices.layer)("readInstalledPackages", (it) => {
  it.effect.each(["project", "global"] as const)(
    "follows the %s store graph through aliases, hidden exports, and cycles",
    (layout) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "installed-packages-" });
        const root = yield* fs.realPath(temporary);
        const project = path.join(root, "project");
        const modules = path.join(project, "node_modules");
        const store = layout === "project" ? path.join(modules, ".pnpm") : path.join(root, "store");
        const first = path.join(store, "first", "node_modules", "first");
        const second = path.join(store, "second", "node_modules", "second");
        const nativeOne = path.join(store, "native-one", "node_modules", "@scope", "native");
        const nativeTwo = path.join(store, "native-two", "node_modules", "@scope", "native");
        const peer = path.join(store, "peer", "node_modules", "peer");
        const dev = path.join(store, "dev", "node_modules", "dev");
        const unrelated = path.join(store, "unrelated", "node_modules", "unrelated");

        yield* writePackage(project, {
          name: "app",
          dependencies: { alias: "npm:first@1", second: "1" },
          devDependencies: { dev: "1" },
        });
        yield* writePackage(first, {
          name: "first",
          exports: {},
          dependencies: { "@scope/native": "1", second: "1" },
          optionalDependencies: { "missing-platform": "1" },
          peerDependencies: { peer: "1", "missing-peer": "1" },
          devDependencies: { unrelated: "1" },
        });
        yield* writePackage(second, {
          name: "second",
          dependencies: { "@scope/native": "2", first: "1" },
        });
        yield* writePackage(nativeOne, { name: "@scope/native", version: "1" });
        yield* writePackage(nativeTwo, { name: "@scope/native", version: "2" });
        yield* writePackage(peer, { name: "peer" });
        yield* writePackage(dev, { name: "dev" });
        yield* writePackage(unrelated, { name: "unrelated" });

        yield* linkPackage(first, path.join(modules, "alias"));
        yield* linkPackage(second, path.join(modules, "second"));
        yield* linkPackage(dev, path.join(modules, "dev"));
        yield* linkPackage(nativeOne, path.join(path.dirname(first), "@scope", "native"));
        yield* linkPackage(nativeTwo, path.join(path.dirname(second), "@scope", "native"));
        yield* linkPackage(second, path.join(path.dirname(first), "second"));
        yield* linkPackage(first, path.join(path.dirname(second), "first"));
        yield* linkPackage(peer, path.join(path.dirname(first), "peer"));
        yield* linkPackage(unrelated, path.join(path.dirname(first), "unrelated"));

        const installed = yield* readInstalledPackages([project]);
        assert.deepStrictEqual(
          [...installed.keys()].sort(),
          [project, first, second, nativeOne, nativeTwo, peer, dev].sort(),
        );
        assert.strictEqual(installed.get(first)?.name, "first");
        assert.strictEqual(installed.get(nativeOne)?.name, "@scope/native");
        assert.strictEqual(installed.get(nativeTwo)?.name, "@scope/native");
      }),
  );

  it.effect("reads nested and hoisted packages without a pnpm store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "installed-hoisted-" });
      const root = yield* fs.realPath(temporary);
      const first = path.join(root, "node_modules", "first");
      const hoisted = path.join(root, "node_modules", "hoisted");
      const nested = path.join(first, "node_modules", "nested");
      yield* writePackage(root, { name: "app", dependencies: { first: "1" } });
      yield* writePackage(first, { name: "first", dependencies: { hoisted: "1", nested: "1" } });
      yield* writePackage(hoisted, { name: "hoisted" });
      yield* writePackage(nested, { name: "nested" });

      const installed = yield* readInstalledPackages([root]);
      assert.deepStrictEqual([...installed.keys()].sort(), [root, first, hoisted, nested].sort());
    }),
  );
});
