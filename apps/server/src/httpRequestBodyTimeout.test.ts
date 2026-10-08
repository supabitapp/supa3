// @effect-diagnostics nodeBuiltinImport:off - Verify the native HTTP timeout event behavior.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { guardHttpRequestBodyTimeout } from "./httpRequestBodyTimeout.ts";

const servers = new Set<NodeHttp.Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function startServer(handler: NodeHttp.RequestListener) {
  const server = guardHttpRequestBodyTimeout(NodeHttp.createServer({ requestTimeout: 0 }, handler));
  server.setTimeout(25);
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

describe("HTTP request body inactivity", () => {
  it.each(["/long-response", "/api/attachments/upload/signed"])(
    "closes a stalled pipelined body behind a held response (%s)",
    async (firstPath) => {
      const requests: string[] = [];
      const pipelined = Promise.withResolvers<void>();
      const origin = await startServer((request) => {
        requests.push(request.url!);
        request.resume();
        if (requests.length === 2) pipelined.resolve();
      });
      const port = Number(new URL(origin).port);
      const socket = NodeNet.createConnection({ port, host: "127.0.0.1" });
      const closed = new Promise<void>((resolve, reject) => {
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });
      socket.write(
        `POST ${firstPath} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\n\r\na` +
          "POST /stalled HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\na",
      );
      await pipelined.promise;
      await closed;
      expect(requests).toEqual([firstPath, "/stalled"]);
    },
  );
  it("closes a stalled incomplete non-upload body", async () => {
    const origin = await startServer(() => {});
    const request = NodeHttp.request(origin, {
      method: "POST",
      headers: { "content-length": "2" },
    });
    const closed = new Promise<Error>((resolve) => request.once("error", resolve));
    request.write("a");
    const error = await closed;
    expect(error).toMatchObject({ code: "ECONNRESET" });
  });

  it("keeps completed requests and upload disk backpressure outside socket inactivity", async () => {
    const uploadArrived = Promise.withResolvers<NodeHttp.IncomingMessage>();
    const waitingResponse = Promise.withResolvers<void>();
    const origin = await startServer((request, response) => {
      if (request.url === "/api/attachments/upload/signed") {
        uploadArrived.resolve(request);
        let bytes = "";
        request.on("data", (chunk) => {
          bytes += chunk;
        });
        request.on("end", () => response.end(bytes));
      } else {
        response.once("timeout", () => {
          waitingResponse.resolve();
          response.end("long response survived");
        });
      }
    });
    const upload = NodeHttp.request(`${origin}/api/attachments/upload/signed`, {
      method: "POST",
      headers: { "content-length": "2" },
    });
    const uploadResponse = new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
      upload.once("response", resolve);
      upload.once("error", reject);
    });
    upload.write("a");
    await uploadArrived.promise;
    const completeResponse = new Promise<string>((resolve, reject) => {
      NodeHttp.get(origin, (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });
    await waitingResponse.promise;
    expect(await completeResponse).toBe("long response survived");
    upload.end("b");
    const response = await uploadResponse;
    let bytes = "";
    response.on("data", (chunk: Buffer) => {
      bytes += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      response.once("end", resolve);
      response.once("error", reject);
    });
    expect(bytes).toBe("ab");
  });
});
