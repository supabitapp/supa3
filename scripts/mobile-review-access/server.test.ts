// @effect-diagnostics nodeBuiltinImport:off - These tests exercise the standalone review access service over HTTP.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createReviewAccessServer } from "./server.ts";

const servers: NodeHttp.Server[] = [];
const publicUrl = "https://review.example.test";
const invitation = "test-review-invitation";

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
        JSON.stringify({
          credential: `PAIRING-EXAMPLE-${requests.length}`,
          expiresAt: "2030-01-01T12:05:00Z",
        }),
    );
  });
  const backendUrl = await listen(backend);
  const access = await createReviewAccessServer({
    publicUrl,
    backendUrl,
    adminToken: "private-admin-token",
    invitationSha256: NodeCrypto.createHash("sha256").update(invitation).digest("hex"),
  });
  const accessUrl = await listen(access);
  const pair = (accessInvitation = invitation, origin = publicUrl, body: unknown = {}) =>
    fetch(`${accessUrl}/review/pairing`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(accessInvitation ? { Authorization: `Bearer ${accessInvitation}` } : {}),
      },
      body: JSON.stringify(body),
    });
  return { accessUrl, requests, pair };
}

describe("mobile review access", () => {
  it("keeps invitations and connection tokens out of the public page", async () => {
    const { accessUrl, requests } = await setup();
    const response = await fetch(`${accessUrl}/review`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).not.toContain("private-admin-token");
    expect(page).not.toContain(invitation);
    expect(page).not.toContain("PAIRING-EXAMPLE");
    expect(requests).toHaveLength(0);
  });

  it("refuses missing and incorrect invitations without creating a pairing grant", async () => {
    const { requests, pair } = await setup();
    expect((await pair("")).status).toBe(401);
    expect((await pair("incorrect")).status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  it("refuses requests from another origin even with a valid invitation", async () => {
    const { requests, pair } = await setup();
    expect((await pair(invitation, "https://another.example.test")).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it("creates a connection link and QR code with review permissions", async () => {
    const { requests, pair } = await setup();
    const response = await pair();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.pairingUrl).toBe(`${publicUrl}/pair#token=PAIRING-EXAMPLE-1`);
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
    expect((await pair(invitation, publicUrl, { extra: "x".repeat(5000) })).status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  it("reports an unavailable environment when its pairing response is invalid", async () => {
    const { pair } = await setup("invalid JSON");
    const response = await pair();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The review environment is unavailable. Please try again.",
    });
  });

  it("lets the same invitation connect another device with a fresh pairing grant", async () => {
    const { pair, requests } = await setup();
    const first = await (await pair()).json();
    const second = await (await pair()).json();
    expect(first.pairingUrl).not.toBe(second.pairingUrl);
    expect(requests).toHaveLength(2);
  });
});
