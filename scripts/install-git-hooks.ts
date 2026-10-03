import * as NodeChildProcess from "node:child_process";

const hkSupported = !(process.platform === "darwin" && process.arch === "x64");
const config = NodeChildProcess.spawnSync(
  "mise",
  ["exec", "--", "vp", "config", ...(hkSupported ? ["--no-hooks"] : []), "--no-agent"],
  { stdio: "inherit" },
);
if (config.error) throw config.error;
if (config.status !== 0) process.exit(config.status ?? 1);
if (process.env.CI || !hkSupported) process.exit(0);

const result = NodeChildProcess.spawnSync("mise", ["run", "hooks:install"], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
