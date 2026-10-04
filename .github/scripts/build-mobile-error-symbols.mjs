import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const root = process.cwd();
const mobile = NodePath.join(root, "apps/mobile");
const credentials = NodePath.join(mobile, ".posthog-build.env");
const easIgnore = NodePath.join(mobile, ".easignore");
const profileFile = NodePath.join(mobile, "eas.json");
const originalProfile = await NodeFSP.readFile(profileFile, "utf8");
const originalIgnore = await NodeFSP.readFile(easIgnore, "utf8").catch(() => undefined);
const key = process.env.POSTHOG_CLI_API_KEY;
if (!key) throw new Error("Missing process-scoped symbol credential");
if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${key}`);
let createdCredentials = false;
try {
  // Local EAS builds copy the credential file into their private build tree.
  // It is never a public Expo variable and is removed before any subsequent step.
  await NodeFSP.writeFile(
    credentials,
    `POSTHOG_CLI_API_KEY=${key}\nPOSTHOG_CLI_PROJECT_ID=645568\nPOSTHOG_CLI_HOST=https://us.posthog.com\n`,
    { mode: 0o600, flag: "wx" },
  );
  createdCredentials = true;
  const ignores =
    originalIgnore ??
    `${await NodeFSP.readFile(NodePath.join(root, ".gitignore"), "utf8")}\n${await NodeFSP.readFile(NodePath.join(mobile, ".gitignore"), "utf8")}`;
  await NodeFSP.writeFile(easIgnore, `${ignores}\n!.posthog-build.env\n`);
  const config = JSON.parse(originalProfile);
  const release = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  config.build.production.env.EXPO_PUBLIC_POSTHOG_RELEASE = release;
  await NodeFSP.writeFile(profileFile, JSON.stringify(config));
  const result = NodeChildProcess.spawnSync(
    "eas",
    [
      "build",
      "--local",
      "--platform",
      process.env.MOBILE_PLATFORM,
      "--profile",
      process.env.MOBILE_PROFILE,
      "--non-interactive",
      "--freeze-credentials",
      "--output",
      process.env.MOBILE_BINARY,
    ],
    { cwd: mobile, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) throw new Error("Native build or symbol upload failed");
} finally {
  if (createdCredentials) await NodeFSP.rm(credentials, { force: true });
  await NodeFSP.writeFile(profileFile, originalProfile);
  if (originalIgnore === undefined) await NodeFSP.rm(easIgnore, { force: true });
  else await NodeFSP.writeFile(easIgnore, originalIgnore);
}
