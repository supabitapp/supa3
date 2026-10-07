import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PackageManifest = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(PackageManifest));

// Follow Node's directory lookup without importing package code or requiring
// package.json to be public in the package's exports map.
const resolveDependencyDirectory = Effect.fn("resolveDependencyDirectory")(function* (
  fromDirectory: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (yield* fs.exists(path.join(candidate, "package.json"))) {
      return yield* fs.realPath(candidate);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
});

/** Inventory the installed graph, retaining different versions and peer contexts. */
export const readInstalledPackages = Effect.fn("readInstalledPackages")(function* (
  packageDirectories: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installed = new Map<string, typeof PackageManifest.Type>();
  const roots = new Set(
    yield* Effect.forEach(packageDirectories, (directory) => fs.realPath(directory)),
  );
  const pending = [...roots];
  for (const directory of pending) {
    if (installed.has(directory)) continue;
    const manifest = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(Effect.flatMap(decodeManifest));
    installed.set(directory, manifest);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      // Dependency packages do not install their own development dependencies.
      ...(roots.has(directory) ? manifest.devDependencies : undefined),
    };
    for (const name of Object.keys(dependencies)) {
      const dependency = yield* resolveDependencyDirectory(directory, name);
      // Optional/platform-specific packages and optional peers may be absent.
      if (dependency !== null && !installed.has(dependency)) pending.push(dependency);
    }
  }
  return installed;
});
