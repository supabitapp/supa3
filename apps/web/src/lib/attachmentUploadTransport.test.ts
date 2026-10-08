import {
  ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS,
  ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS,
} from "@supacode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { uploadAttachmentBlob } from "./attachmentUploadTransport";

class UploadRequest extends EventTarget {
  static latest: UploadRequest;
  readonly upload = new EventTarget();
  status = 0;
  readonly abort = vi.fn(() => this.dispatchEvent(new Event("abort")));
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn();

  constructor() {
    super();
    UploadRequest.latest = this;
  }

  progress(loaded: number) {
    this.upload.dispatchEvent(
      Object.assign(new Event("progress"), { loaded, total: 100, lengthComputable: true }),
    );
  }

  complete(status: number) {
    this.status = status;
    this.dispatchEvent(new Event("load"));
  }
}

function startUpload() {
  return uploadAttachmentBlob({ url: "/upload", body: new Blob(["file"]), mimeType: "text/plain" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("attachment upload inactivity deadline", () => {
  it("keeps an advancing upload alive beyond the former five-minute limit", async () => {
    const upload = startUpload();
    for (let step = 1; step <= 12; step++) {
      await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS / 2);
      UploadRequest.latest.progress(step);
    }
    expect(UploadRequest.latest.abort).not.toHaveBeenCalled();
    UploadRequest.latest.complete(204);
    await upload.done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts when progress events stop advancing the byte count", async () => {
    const upload = startUpload();
    const failure = expect(upload.done).rejects.toThrow("Upload timed out");
    UploadRequest.latest.progress(10);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS / 2);
    UploadRequest.latest.progress(10);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS / 2);
    await failure;
    expect(UploadRequest.latest.abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the wait for a response after all bytes have been sent", async () => {
    const upload = startUpload();
    const failure = expect(upload.done).rejects.toThrow("Upload timed out");
    UploadRequest.latest.progress(100);
    UploadRequest.latest.upload.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS);
    await failure;
  });

  it("allows the final tunnel buffers to drain beyond the upload idle deadline", async () => {
    const upload = startUpload();
    UploadRequest.latest.progress(100);
    UploadRequest.latest.upload.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS * 2);
    UploadRequest.latest.progress(100);
    expect(UploadRequest.latest.abort).not.toHaveBeenCalled();
    UploadRequest.latest.complete(204);
    await upload.done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels immediately and ignores progress after cancellation", async () => {
    const upload = startUpload();
    const failure = expect(upload.done).rejects.toThrow("Upload cancelled");
    upload.abort();
    await failure;
    UploadRequest.latest.progress(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves rejected HTTP status for retry classification", async () => {
    const upload = startUpload();
    const failure = expect(upload.done).rejects.toMatchObject({
      status: 429,
      message: "Upload rejected (429)",
    });
    UploadRequest.latest.complete(429);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its deadline when the connection fails", async () => {
    const upload = startUpload();
    const failure = expect(upload.done).rejects.toThrow("Upload failed");
    UploadRequest.latest.dispatchEvent(new Event("error"));
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
});
