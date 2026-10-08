// @effect-diagnostics nodeBuiltinImport:off - Configure Node's request/socket inactivity hooks.
import type * as NodeHttp from "node:http";
import { ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS } from "@supacode/contracts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "./assets/AttachmentUpload.ts";

/** Bound incomplete request bodies while allowing long MCP waits and downloads. */
export function guardHttpRequestBodyTimeout(server: NodeHttp.Server): NodeHttp.Server {
  server.setTimeout(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
  server.on("request", (request, response) => {
    if (
      request.method === "POST" &&
      request.url?.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`)
    ) {
      // Uploads time each body pull, excluding downstream disk writes. Their
      // rejection responses close the connection if the body is still unread.
      request.socket.setTimeout(0);
      return;
    }
    request.socket.setTimeout(server.timeout);
    request.on("timeout", () => request.socket.destroy());
    response.on("timeout", () => {
      if (!request.complete) request.socket.destroy();
    });
  });
  return server;
}
