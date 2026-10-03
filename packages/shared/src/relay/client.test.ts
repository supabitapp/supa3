import { expect, it, vi } from "vite-plus/test";
import { createRelayFetch } from "./client.ts";

it("reads materialized relay assets without a native network request", async () => {
  const nativeFetch = vi.fn<typeof fetch>();
  const relayFetch = createRelayFetch(nativeFetch, {
    randomBytes: () => {
      throw new Error("No handshake expected");
    },
    createSocket: () => {
      throw new Error("No socket expected");
    },
  });
  const url = "data:application/octet-stream;base64,AAH+/w==";
  const response = await relayFetch(url);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0, 1, 254, 255));
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(nativeFetch).not.toHaveBeenCalled();
  await expect(relayFetch(url, { signal: AbortSignal.abort() })).rejects.toThrow();
});
