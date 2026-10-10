// @effect-diagnostics nodeBuiltinImport:off - These tests exercise the standalone review access service over HTTP.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createReviewAccessServer } from "./server.ts";

const servers: NodeHttp.Server[] = [];
const publicUrl = "https://review.example.test";
const credentials = { username: "reviewer", password: "test-review-password" };

async function listen(server: NodeHttp.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a port.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function setup(backendResponse?: string) {
  const requests: Array<{ authorization: string | undefined; body: unknown }> = [];
  const backend = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      backendResponse ??
        JSON.stringify({ credential: "PAIRING-EXAMPLE", expiresAt: "2030-01-01T12:05:00Z" }),
    );
  });
  const backendUrl = await listen(backend);
  const access = await createReviewAccessServer({
    publicUrl,
    backendUrl,
    adminToken: "private-admin-token",
    credentialSha256: NodeCrypto.createHash("sha256")
      .update(`${credentials.username}:${credentials.password}`)
      .digest("hex"),
  });
  const accessUrl = await listen(access);
  const pair = (body: unknown, origin = publicUrl) =>
    fetch(`${accessUrl}/review/pairing`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { accessUrl, requests, pair };
}

describe("mobile review access", () => {
  it("keeps credentials and connection tokens out of the public page", async () => {
    const { accessUrl, requests } = await setup();
    const response = await fetch(`${accessUrl}/review`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).not.toContain("private-admin-token");
    expect(page).not.toContain(credentials.password);
    expect(page).not.toContain("PAIRING-EXAMPLE");
    expect(requests).toHaveLength(0);
  });

  it("refuses incorrect credentials without creating a pairing grant", async () => {
    const { requests, pair } = await setup();
    expect((await pair({ ...credentials, password: "incorrect" })).status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  it("refuses requests from another origin even with valid credentials", async () => {
    const { requests, pair } = await setup();
    expect((await pair(credentials, "https://another.example.test")).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it("creates a connection link and QR code with review permissions", async () => {
    const { requests, pair } = await setup();
    const response = await pair(credentials);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.pairingUrl).toBe(`${publicUrl}/pair#token=PAIRING-EXAMPLE`);
    expect(result.expiresAt).toBe("2030-01-01T12:05:00Z");
    expect(result.qrImage).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.stringify(result)).not.toContain("private-admin-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer private-admin-token");
    expect(requests[0]?.body).toMatchObject({
      label: "App review",
      scopes: expect.arrayContaining(["orchestration:operate", "filesystem:write"]),
    });
    const body = requests[0]?.body as { scopes: string[] };
    expect(body.scopes).not.toContain("access:write");
    expect(body.scopes).not.toContain("providers:manage");
  });

  it("rejects oversized requests before creating a pairing grant", async () => {
    const { requests, pair } = await setup();
    expect((await pair({ ...credentials, extra: "x".repeat(5000) })).status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  it("reports an unavailable environment when its pairing response is invalid", async () => {
    const { pair } = await setup("invalid JSON");
    const response = await pair(credentials);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The review environment is unavailable. Please try again.",
    });
  });
});
