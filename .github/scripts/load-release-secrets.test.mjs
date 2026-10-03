import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

function run(secrets, exitCode = 0) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-secrets-"));
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  const payload = NodePath.join(root, "payload.json");
  NodeFS.writeFileSync(payload, JSON.stringify({ metadata: {}, secrets }));
  NodeFS.writeFileSync(
    NodePath.join(bin, "fnox"),
    `#!/bin/sh\ncat "$TEST_SECRET_PAYLOAD"\nexit ${exitCode}\n`,
    {
      mode: 0o700,
    },
  );
  const envFile = NodePath.join(root, "github-env");
  NodeFS.writeFileSync(envFile, "");
  try {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.resolve(".github/scripts/load-release-secrets.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
          RELEASE_SECRET_PROFILE: "release-app",
          OP_SERVICE_ACCOUNT_TOKEN: "test-token",
          GITHUB_ENV: envFile,
          TEST_SECRET_PAYLOAD: payload,
        },
      },
    );
    return { ...result, environment: NodeFS.readFileSync(envFile, "utf8") };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

NodeTest.test("preserves multiline credentials and masks workflow command characters", () => {
  const key = "private%key\r\nsecond line\n";
  const result = run({
    RELEASE_APP_ID: "123",
    RELEASE_APP_PRIVATE_KEY: key,
    UNRELATED: "excluded",
  });
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.match(result.stdout, /::add-mask::private%25key%0D%0Asecond line%0A/);
  NodeAssert.ok(result.environment.includes(`${key}\nfnox_`));
  NodeAssert.ok(!result.environment.includes("UNRELATED"));
  NodeAssert.equal(result.stdout.split("\n").filter(Boolean).length, 2);
});

NodeTest.test("missing credentials do not partially populate the job environment", () => {
  const result = run({ RELEASE_APP_ID: "123" });
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.equal(result.environment, "");
  NodeAssert.equal(result.stdout, "");
});

NodeTest.test("provider failures do not expose captured secrets in errors", () => {
  const result = run({ RELEASE_APP_ID: "sensitive-test-value" }, 1);
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.equal(result.environment, "");
  NodeAssert.ok(!result.stderr.includes("sensitive-test-value"));
  NodeAssert.equal(result.stdout, "");
});
