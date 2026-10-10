// @effect-diagnostics nodeBuiltinImport:off - This standalone service runs beside the isolated mobile review environment.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { QrCode } from "../../packages/shared/src/qrCode.ts";

const REVIEW_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
];

interface ReviewAccessConfig {
  publicUrl: string;
  backendUrl: string;
  adminToken: string;
  credentialSha256: string;
}

function qrImage(value: string) {
  const qr = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const size = qr.size + 8;
  const squares: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) squares.push(`M${x + 4},${y + 4}h1v1h-1z`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size}v${size}H0z"/><path fill="black" d="${squares.join("")}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function createReviewAccessServer(config: ReviewAccessConfig) {
  const origin = new URL(config.publicUrl).origin;
  if (!/^[a-f0-9]{64}$/.test(config.credentialSha256) || !config.adminToken.trim()) {
    throw new Error("Review access requires a credential digest and an administrative token.");
  }
  const digest = Buffer.from(config.credentialSha256, "hex");
  const assets = import.meta.dirname;
  const [page, script] = await Promise.all([
    NodeFSP.readFile(NodePath.join(assets, "page.html"), "utf8"),
    NodeFSP.readFile(NodePath.join(assets, "page.js"), "utf8"),
  ]);
  const server = NodeHttp.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const respond = (status: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const pathname = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && (pathname === "/review" || pathname === "/review/")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    if (request.method === "GET" && pathname === "/review/page.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    if (pathname !== "/review/pairing") {
      respond(404, { error: "Page not found." });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      respond(405, { error: "Use POST to create a connection link." });
      return;
    }
    if (
      request.headers.origin !== origin ||
      request.headers["content-type"] !== "application/json"
    ) {
      respond(403, { error: "Create the connection link from the review access page." });
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 4096) {
          respond(413, { error: "Request is too large." });
          return;
        }
      }
      let credentials: unknown;
      try {
        credentials = JSON.parse(body);
      } catch {
        respond(400, { error: "Enter the review username and password." });
        return;
      }
      if (
        !credentials ||
        typeof credentials !== "object" ||
        !("username" in credentials) ||
        !("password" in credentials) ||
        typeof credentials.username !== "string" ||
        typeof credentials.password !== "string"
      ) {
        respond(400, { error: "Enter the review username and password." });
        return;
      }
      const submitted = NodeCrypto.createHash("sha256")
        .update(`${credentials.username}:${credentials.password}`)
        .digest();
      if (!NodeCrypto.timingSafeEqual(submitted, digest)) {
        respond(401, { error: "The review username or password is incorrect." });
        return;
      }
      const grantResponse = await fetch(new URL("/api/auth/pairing-token", config.backendUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: "App review", scopes: REVIEW_SCOPES }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!grantResponse.ok) {
        respond(503, { error: "The review environment is unavailable. Please try again." });
        return;
      }
      const grant: unknown = await grantResponse.json();
      if (
        !grant ||
        typeof grant !== "object" ||
        !("credential" in grant) ||
        !("expiresAt" in grant) ||
        typeof grant.credential !== "string" ||
        typeof grant.expiresAt !== "string"
      ) {
        respond(503, { error: "The review environment could not create a connection link." });
        return;
      }
      const pairingUrl = new URL("/pair", origin);
      pairingUrl.hash = new URLSearchParams({ token: grant.credential }).toString();
      respond(200, {
        pairingUrl: pairingUrl.toString(),
        expiresAt: grant.expiresAt,
        qrImage: qrImage(pairingUrl.toString()),
      });
    } catch {
      respond(503, { error: "The review environment is unavailable. Please try again." });
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 15_000;
  return server;
}

if (import.meta.main) {
  const tokenFile = process.env.SUPACODE_REVIEW_ADMIN_TOKEN_FILE;
  const publicUrl = process.env.SUPACODE_REVIEW_PUBLIC_URL;
  const credentialSha256 = process.env.SUPACODE_REVIEW_CREDENTIAL_SHA256;
  if (!tokenFile || !publicUrl || !credentialSha256) {
    throw new Error("Review access configuration is incomplete.");
  }
  const server = await createReviewAccessServer({
    publicUrl,
    credentialSha256,
    backendUrl: process.env.SUPACODE_REVIEW_BACKEND_URL ?? "http://127.0.0.1:3773",
    adminToken: (await NodeFSP.readFile(tokenFile, "utf8")).trim(),
  });
  server.listen(Number(process.env.SUPACODE_REVIEW_PORT ?? "3774"), "127.0.0.1");
}
