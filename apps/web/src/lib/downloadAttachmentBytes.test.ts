import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { downloadAttachmentBytes } from "./downloadAttachmentBytes";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function download(signal = new AbortController().signal) {
  return downloadAttachmentBytes({
    url: "http://source.test/asset",
    name: "pasted.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    maxBytes: 50,
    signal,
  });
}

describe("attachment source download", () => {
  it("retains exact binary bytes for destination upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("abc", { headers: { "content-length": "3" } })),
    );
    const file = await download();
    expect(file.name).toBe("pasted.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("abc");
  });

  it("stops a stream that exceeds its declared attachment size", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            },
            cancel,
          }),
        ),
      ),
    );
    await expect(download()).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects an incomplete download", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ab")));
    await expect(download()).rejects.toThrow("incomplete");
  });

  it("allows a slow transfer while bytes continue arriving", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        ),
      ),
    );
    const downloaded = download();
    await vi.advanceTimersByTimeAsync(55_000);
    stream.enqueue(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(55_000);
    stream.enqueue(new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(55_000);
    stream.enqueue(new Uint8Array([3]));
    stream.close();
    expect(new Uint8Array(await (await downloaded).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("ignores a superseded recovery", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("abc")));
    await expect(download(controller.signal)).rejects.toThrow();
  });
});
