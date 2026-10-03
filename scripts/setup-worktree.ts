// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored `.env` into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);

const miseInstall = NodeChildProcess.spawnSync(
  "mise",
  ["install", "--locked", "node", "pnpm", "npm:vite-plus"],
  {
    cwd: worktree,
    stdio: "inherit",
  },
);
if (miseInstall.status !== 0) process.exit(miseInstall.status ?? 1);

const install = NodeChildProcess.spawnSync("mise", ["exec", "--", "vp", "i"], {
  cwd: worktree,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

// In the main checkout itself, relinking would replace the real env file.
const envSource = NodePath.join(projectRoot, ".env");
if (
  NodeFS.realpathSync(projectRoot) !== NodeFS.realpathSync(worktree) &&
  NodeFS.existsSync(envSource)
) {
  const envTarget = NodePath.join(worktree, ".env");
  NodeFS.rmSync(envTarget, { force: true });
  NodeFS.symlinkSync(envSource, envTarget);
}

const warm = NodeChildProcess.spawnSync(
  "mise",
  ["exec", "--", "node", NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
