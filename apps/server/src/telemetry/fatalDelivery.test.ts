// @effect-diagnostics nodeBuiltinImport:off - integration test drives a genuinely fatal child process and a local HTTP receiver.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("delivers a redacted fatal report and preserves Node's fatal exit", async () => {
  const received: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      received.push(body);
      response.writeHead(200);
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing receiver address");
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "supacode-fatal-test-"));
  try {
    const entry = NodePath.join(directory, "parent.mjs");
    const helper = NodeURL.pathToFileURL(
      NodePath.join(import.meta.dirname, "fatalDelivery.ts"),
    ).href;
    await NodeFSP.writeFile(
      entry,
      `
      import { deliverFatalException, runFatalDelivery } from ${JSON.stringify(helper)};
      if (process.argv[2] === "report-error") await runFatalDelivery();
      else {
        process.on("uncaughtExceptionMonitor", () => deliverFatalException({
          report: {operation: "uncaught", release: "abc123", exceptions: [{type: "TypeError", value: "private-secret", stacktrace: {type: "raw", frames: [{platform: "node:javascript", filename: "/Users/private/app.mjs", lineno: 42, colno: 3, chunk_id: "12345678-abcd"}]}}]},
          host: "http://127.0.0.1:${address.port}", key: "test-key", identifier: "anonymous-test", properties: {surface: "server"}
        }));
        setImmediate(() => { throw new TypeError("private-secret"); });
      }
    `,
    );
    const child = NodeChildProcess.spawn(process.execPath, [entry], { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(code).toBe(1);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]!);
    expect(payload.batch[0].event).toBe("$exception");
    expect(payload.batch[0].properties.$exception_list[0].stacktrace.frames[0]).toMatchObject({
      filename: "app.mjs",
      lineno: 42,
      chunk_id: "12345678-abcd",
    });
    expect(received[0]).not.toMatch(/private-secret|Users|session_id|exception_steps/);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
