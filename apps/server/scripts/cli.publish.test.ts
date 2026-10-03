import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
import { expect, it } from "vite-plus/test";

it.skipIf(process.platform === "win32")(
  "discovers public platform archives and publishes the launcher last",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "supacode-publish-"));
    try {
      const scope = NodePath.join(directory, "@supabitapp");
      const bin = NodePath.join(directory, "bin");
      const log = NodePath.join(directory, "calls.jsonl");
      NodeFS.mkdirSync(scope);
      NodeFS.mkdirSync(bin);
      const platform = NodePath.join(scope, "supacode-linux-arm64.tgz");
      const launcher = NodePath.join(directory, "supacode.tgz");
      NodeFS.writeFileSync(platform, "fixture");
      NodeFS.writeFileSync(launcher, "fixture");
      NodeFS.writeFileSync(
        NodePath.join(bin, "npm"),
        `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
        { mode: 0o755 },
      );

      NodeChildProcess.execFileSync(
        process.execPath,
        [
          NodeUrl.fileURLToPath(new URL("./cli.ts", import.meta.url)),
          "publish",
          "--packages-dir",
          directory,
          "--tag",
          "preview",
          "--dry-run",
        ],
        { env: { ...process.env, PATH: `${bin}${NodePath.delimiter}${process.env.PATH}` } },
      );

      const calls = NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        ["publish", "--access", "public", "--tag", "preview", "--dry-run", platform],
        ["publish", "--access", "public", "--tag", "preview", "--dry-run", launcher],
      ]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
