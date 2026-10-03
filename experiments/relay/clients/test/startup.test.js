import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { relayDir, startRelay } from "../lib.js";

describe("startup", () => {
  test("port 0 prints the actual loopback address as a standalone JSON line", async () => {
    const relay = await startRelay();
    assert.match(relay.address, /^127\.0\.0\.1:\d+$/);
    assert.notEqual(relay.address, "127.0.0.1:0");
    assert.equal((await relay.stop()).code, 0);
  });

  test("invalid configuration exits non-zero with a message on stderr", () => {
    for (const env of [{ RELAY_MAX_CLIENTS: "lots" }, { RELAY_ADDR: "nowhere" }, { RELAY_HEARTBEAT_MS: "0" }]) {
      const result = spawnSync("bash", [path.join(relayDir, "run.sh")], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20000 });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(Object.keys(env)[0]));
    }
  });
});
