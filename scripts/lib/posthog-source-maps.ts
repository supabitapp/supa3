// @effect-diagnostics nodeBuiltinImport:off - build tooling runs outside the application Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@supacode/shared/hostProcess";
import * as NodeTimersPromises from "node:timers/promises";

export async function sourceMapFiles(directory: string): Promise<string[]> {
  const files = await NodeFSP.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    files.map(async (file) => {
      const filename = NodePath.join(directory, file.name);
      return file.isDirectory()
        ? sourceMapFiles(filename)
        : file.name.endsWith(".map")
          ? [filename]
          : [];
    }),
  );
  return nested.flat();
}

/** Release uploads fail closed; credentials exist only in the fnox child process. */
export async function uploadSourceMaps(directory: string, namespace = "supacode") {
  const release = process.env.SUPACODE_ERROR_TRACKING_RELEASE;
  if (!release || !/^[a-f0-9]{40}$/.test(release))
    throw new Error("Error symbol uploads require the checked-out commit SHA.");
  if (!process.env.POSTHOG_CLI_API_KEY)
    throw new Error("Missing process-scoped error symbol credential.");
  const maps = (await sourceMapFiles(directory)).filter((file) => /\.[cm]?js\.map$/.test(file));
  if (!maps.length) throw new Error(`No JavaScript source maps in ${directory}`);
  const args = [
    "--directory",
    directory,
    "--release-name",
    namespace,
    "--release-version",
    release,
    "--release-mode",
    "event",
  ];
  await runPosthog(["sourcemap", "inject", ...args]);
  for (const map of maps) {
    const chunk = await NodeFSP.readFile(map.slice(0, -4), "utf8");
    if (!/\/\/# chunkId=[a-f0-9-]+/i.test(chunk))
      throw new Error(`Missing error symbol identity: ${map}`);
  }
  await runPosthog(["sourcemap", "upload", ...args, "--delete-after"]);
  if ((await sourceMapFiles(directory)).length)
    throw new Error(`Source maps remain after upload: ${directory}`);
}

export async function runPosthog(args: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = NodeChildProcess.spawnSync("posthog-cli", args, {
      stdio: "inherit",
      timeout: 600_000,
      shell: Effect.runSync(HostProcessPlatform) === "win32",
    });
    if (!result.error && result.status === 0) return;
    if (attempt === 2) throw new Error(`Error symbol command failed: ${args[0]} ${args[1]}`);
    await NodeTimersPromises.setTimeout(2_000 * (attempt + 1));
  }
}
