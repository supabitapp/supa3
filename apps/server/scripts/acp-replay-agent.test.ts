// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const scriptPath = NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url));

const setModeParams = { sessionId: "session-1", modeId: "plan" };

const killOnFirstWrite = `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => {
  process.kill(process.pid, "SIGKILL");
  return write(...args);
};`;

const setModeExchange = [
  {
    type: "expect_outbound",
    frame: { kind: "request", method: "session/set_mode", params: setModeParams },
  },
  {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/set_mode", result: {} },
  },
];

it.each([
  { name: "a final answer", entries: setModeExchange },
  {
    name: "a final answer followed by a clean runtime exit",
    entries: [...setModeExchange, { type: "runtime_exit", status: "success" }],
  },
])("records the replay status before $name leaves the agent", async ({ entries }) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-status-"));
  const statusPath = NodePath.join(directory, "status.json");
  const transcript = { scenario: "status-before-answer", entries };
  try {
    const agent = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        `data:text/javascript,${encodeURIComponent(killOnFirstWrite)}`,
        scriptPath,
      ],
      {
        env: {
          ...process.env,
          SUPACODE_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString(
            "base64",
          ),
          SUPACODE_ACP_REPLAY_STATUS_PATH: statusPath,
          SUPACODE_ACP_REPLAY_WORKSPACE: directory,
        },
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    const exit = once(agent, "exit");
    agent.stdin.end(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/set_mode", params: setModeParams })}\n`,
    );
    const [, signal] = await exit;

    assert.strictEqual(signal, "SIGKILL");
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(statusPath, "utf8")), {
      scenario: "status-before-answer",
      cursor: entries.length,
      total: entries.length,
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
