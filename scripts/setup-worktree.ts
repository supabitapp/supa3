// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the supacode.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell Supacode spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored `.env` into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const projectRoot = process.env.SUPACODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error(
    "SUPACODE_PROJECT_ROOT is not set. Run this through the supacode.json setup action.",
  );
}
const worktree = NodePath.dirname(import.meta.dirname);

const miseInstall = NodeChildProcess.spawnSync("mise", ["install", "--locked"], {
  cwd: worktree,
  stdio: "inherit",
});
if (miseInstall.status !== 0) process.exit(miseInstall.status ?? 1);

const install = NodeChildProcess.spawnSync("mise", ["exec", "--", "vp", "i"], {
  cwd: worktree,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warm = NodeChildProcess.spawnSync(
  "mise",
  ["exec", "--", "node", NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
