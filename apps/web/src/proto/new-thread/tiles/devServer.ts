// @effect-diagnostics nodeBuiltinImport:off - Vite dev middleware spawns the agent CLI directly.
import * as NodeChildProcess from "node:child_process";
import type * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import { extractJsonObject } from "@supacode/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Plugin } from "vite-plus";

import { TILE_JSON_SCHEMA, buildTilePrompt } from "./prompt";
import { TILE_ENDPOINT, TileRequest } from "./protocol";

const TIMEOUT_MS = 120_000;
const MAX_BODY = 64_000;
const MAX_RUNNING = 3;
const OPERATE_SCOPE = "orchestration:operate";
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(TileRequest));

let running = 0;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: NodeHttp.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length <= MAX_BODY) return;
      req.destroy();
      reject(new HttpError(413, "That request is too large."));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function runClaude(prompt: string) {
  return new Promise<unknown>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.env.SUPACODE_PROTO_TILE_CLAUDE || "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(TILE_JSON_SCHEMA),
        "--model",
        process.env.SUPACODE_PROTO_TILE_MODEL || "sonnet",
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ],
      { cwd: NodeOS.tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(504, "The agent took longer than two minutes."));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.stdin.on("error", reject);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `claude exited with code ${code}`));
        return;
      }
      try {
        const reply = JSON.parse(stdout) as {
          is_error?: boolean;
          result?: string;
          structured_output?: unknown;
        };
        if (reply.is_error) throw new Error(reply.result ?? "The agent returned an error.");
        resolve(reply.structured_output ?? JSON.parse(extractJsonObject(reply.result ?? "")));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function send(res: NodeHttp.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function canRunAgents(req: NodeHttp.IncomingMessage, serverOrigin: string) {
  const response = await fetch(new URL("api/auth/session", serverOrigin), {
    headers: {
      cookie: req.headers.cookie ?? "",
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    },
  });
  if (!response.ok) return false;
  const session = (await response.json().catch(() => null)) as {
    authenticated?: boolean;
    scopes?: unknown;
  } | null;
  return (
    session?.authenticated === true &&
    Array.isArray(session.scopes) &&
    session.scopes.includes(OPERATE_SCOPE)
  );
}

async function handle(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  serverOrigin: string | undefined,
) {
  if (req.method !== "POST") throw new HttpError(405, "POST only.");
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Send the request as JSON.");
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin")
    throw new HttpError(403, "Only this app can draw tiles.");
  if (!serverOrigin)
    throw new HttpError(500, "This dev server has no backend to check the sign-in against.");
  if (!(await canRunAgents(req, serverOrigin)))
    throw new HttpError(401, "Sign in to this dev server with a session that can run agents.");
  if (running >= MAX_RUNNING)
    throw new HttpError(429, "Too many tiles are drawing at once. Try again in a moment.");
  const request = decodeRequest(await readBody(req));
  if (Option.isNone(request)) throw new HttpError(400, "That isn't a tile request.");
  running += 1;
  try {
    send(res, 200, { spec: await runClaude(buildTilePrompt(request.value)) });
  } finally {
    running -= 1;
  }
}

export function protoTilePlugin(serverOrigin: string | undefined): Plugin {
  return {
    name: "supacode:proto-tile",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(TILE_ENDPOINT, (req, res) => {
        handle(req, res, serverOrigin).catch((error: unknown) => {
          if (res.headersSent) return;
          send(res, error instanceof HttpError ? error.status : 502, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    },
  };
}
