import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

it.layer(NodeServices.layer)("CLI publication", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "discovers public platform archives and publishes the launcher last",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "supacode-publish-" });
        const scope = path.join(directory, "@supabitapp");
        const bin = path.join(directory, "bin");
        const log = path.join(directory, "calls.jsonl");
        yield* fs.makeDirectory(scope);
        yield* fs.makeDirectory(bin);
        const platform = path.join(scope, "supacode-linux-arm64.tgz");
        const launcher = path.join(directory, "supacode.tgz");
        yield* fs.writeFileString(platform, "fixture");
        yield* fs.writeFileString(launcher, "fixture");
        const npm = path.join(bin, "npm");
        yield* fs.writeFileString(
          npm,
          `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.SUPACODE_TEST_PUBLISH_LOG, process.argv.slice(2).join("\\0") + "\\n");\n`,
        );
        yield* fs.chmod(npm, 0o755);
        const cli = yield* path.fromFileUrl(new URL("./cli.ts", import.meta.url));
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [cli, "publish", "--packages-dir", directory, "--tag", "preview", "--dry-run"],
            {
              env: { PATH: `${bin}:${process.env.PATH}`, SUPACODE_TEST_PUBLISH_LOG: log },
              stdout: "ignore",
              stderr: "inherit",
            },
          ),
        );
        assert.equal(Number(yield* child.exitCode), 0);
        const calls = (yield* fs.readFileString(log))
          .trim()
          .split("\n")
          .map((line) => line.split("\0"));
        assert.deepStrictEqual(calls, [
          ["publish", "--access", "public", "--tag", "preview", "--dry-run", platform],
          ["publish", "--access", "public", "--tag", "preview", "--dry-run", launcher],
        ]);
      }),
  );
});
