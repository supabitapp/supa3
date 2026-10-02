import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import { fixtures } from "./fixtures.mjs";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    name: { type: "string" },
    trials: { type: "string", default: "3" },
    iterations: { type: "string", default: "10" },
    timeout: { type: "string", default: "2000" },
    fixture: { type: "string" },
  },
});
if (!values.output || !values.name || positionals.length === 0) {
  throw new Error(
    "Usage: node run.mjs --name <renderer> --output <directory> [--fixture <id>] -- <worker-command> [args]",
  );
}
const trials = Number(values.trials);
const iterations = Number(values.iterations);
const timeoutMs = Number(values.timeout);
if (![trials, iterations, timeoutMs].every((value) => Number.isInteger(value) && value > 0)) {
  throw new Error("Trials, iterations and timeout must be positive integers");
}
const directory = NodePath.resolve(values.output, values.name);
await NodeFSP.mkdir(directory, { recursive: true });

const percentile = (numbers, fraction) => {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

function startWorker() {
  const startedAt = performance.now();
  const child = NodeChildProcess.spawn(positionals[0], positionals.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const queued = [];
  let pending;
  let failure;
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-8192);
  });
  const fail = (error) => {
    failure = error;
    pending?.reject(error);
    pending = undefined;
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  const interrupt = () => {
    child.kill("SIGKILL");
    process.exit(130);
  };
  const terminate = () => {
    child.kill("SIGKILL");
    process.exit(143);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const exited = new Promise((resolveExit) => {
    child.on("close", (code, signal) => {
      fail(new Error(`Worker exited: ${code ?? signal}. ${stderr}`));
      resolveExit();
    });
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (pending) {
        const listener = pending;
        pending = undefined;
        listener.resolve(value);
      } else {
        queued.push(value);
      }
    } catch {
      fail(new Error(`Invalid worker JSON: ${line.slice(0, 200)}`));
    }
  });
  const next = (limit) => {
    if (failure) return Promise.reject(failure);
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        pending = undefined;
        rejectNext(new Error(`Timeout after ${limit} ms`));
        child.kill("SIGKILL");
      }, limit);
      pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolveNext(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectNext(error);
        },
      };
    });
  };
  return {
    startedAt,
    ready: () => next(10000),
    async render(source) {
      const started = performance.now();
      const response = next(timeoutMs);
      child.stdin.write(`${JSON.stringify({ source })}\n`);
      return { ...(await response), roundTripMs: performance.now() - started };
    },
    async stop() {
      child.kill("SIGKILL");
      await exited;
      lines.close();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    },
  };
}

const results = [];
const selected = fixtures.filter((fixture) => !values.fixture || fixture.id === values.fixture);
if (!selected.length) throw new Error("No matching fixture");
for (const fixture of selected) {
  const samples = [];
  for (let trial = 0; trial < trials; trial++) {
    const worker = startWorker();
    const sample = { trial, startupMs: null, coldMs: null, responses: [], failure: null };
    try {
      sample.ready = await worker.ready();
      if (sample.ready.ready !== true) throw new Error("Invalid worker ready response");
      sample.startupMs = performance.now() - worker.startedAt;
      for (let iteration = 0; iteration <= iterations; iteration++) {
        const response = await worker.render(fixture.source);
        if (iteration === 0) sample.coldMs = performance.now() - worker.startedAt;
        const output = response.output ?? "";
        if (trial === 0 && iteration === 0 && output) {
          await NodeFSP.writeFile(
            NodePath.resolve(
              directory,
              `${fixture.id}.${output.trimStart().startsWith("<svg") ? "svg" : "txt"}`,
            ),
            output,
          );
        }
        const visibleText = output
          .replace(/<[^>]*>/g, " ")
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
        sample.responses.push({
          iteration,
          renderMs: response.renderMs,
          roundTripMs: response.roundTripMs,
          bytes: Buffer.byteLength(output),
          lines: output.split("\n").length,
          columns: Math.max(...output.split("\n").map((line) => Array.from(line).length)),
          error: response.error ?? null,
          missingLabels: fixture.labels.filter((label) => !visibleText.includes(label)),
          rejectedMalformed: fixture.expectError ? Boolean(response.error) : null,
        });
        if (response.error) break;
      }
    } catch (error) {
      sample.failure = String(error);
    } finally {
      await worker.stop();
    }
    samples.push(sample);
  }
  const warm = samples.flatMap((sample) =>
    sample.responses.filter((response) => response.iteration > 0 && !response.error),
  );
  const result = {
    fixture: fixture.id,
    source: fixture.source,
    expectedLabels: fixture.labels,
    expectError: fixture.expectError ?? false,
    coldMedianMs: percentile(
      samples.flatMap((sample) => (sample.coldMs === null ? [] : [sample.coldMs])),
      0.5,
    ),
    warmMedianMs: percentile(
      warm.map((response) => response.renderMs),
      0.5,
    ),
    warmP95Ms: percentile(
      warm.map((response) => response.renderMs),
      0.95,
    ),
    roundTripMedianMs: percentile(
      warm.map((response) => response.roundTripMs),
      0.5,
    ),
    samples,
  };
  results.push(result);
  console.log(
    JSON.stringify({
      fixture: fixture.id,
      coldMs: result.coldMedianMs,
      warmMs: result.warmMedianMs,
      failures: samples.filter((sample) => sample.failure).length,
      missingLabels: samples[0]?.responses[0]?.missingLabels,
      error: samples[0]?.responses[0]?.error,
    }),
  );
  await NodeFSP.writeFile(
    NodePath.resolve(directory, "results.json"),
    JSON.stringify(
      {
        name: values.name,
        command: positionals,
        environment: {
          cpu: NodeOS.cpus()[0]?.model,
          platform: NodeOS.type(),
          arch: NodeOS.machine(),
          node: process.version,
        },
        trials,
        iterations,
        timeoutMs,
        results,
      },
      null,
      2,
    ),
  );
}
