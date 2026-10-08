import {
  ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS,
  ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS,
} from "@supacode/contracts";

export class AttachmentUploadHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Upload rejected (${status})`);
    this.status = status;
  }
}

/** Upload file-backed bytes with an inactivity deadline rather than a size-dependent time limit. */
export function uploadAttachmentBlob(input: {
  readonly url: string;
  readonly body: Blob;
  readonly mimeType: string;
  readonly onProgress?: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    let idle: ReturnType<typeof setTimeout>;
    let settled = false;
    let uploaded = 0;
    let bodySent = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      if (error) reject(error);
      else resolve();
    };
    const armDeadline = (duration: number) => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        finish(new Error("Upload timed out"));
        xhr.abort();
      }, duration);
    };
    xhr.open("POST", input.url, true);
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (settled) return;
      if (!bodySent && event.loaded > uploaded) {
        uploaded = event.loaded;
        armDeadline(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
      }
      if (event.lengthComputable && event.total > 0) {
        input.onProgress?.(event.loaded / event.total);
      }
    });
    xhr.upload.addEventListener("load", () => {
      if (settled) return;
      bodySent = true;
      // Progress can finish before socket and tunnel buffers reach the host.
      armDeadline(ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS);
    });
    xhr.addEventListener("load", () =>
      finish(
        xhr.status >= 200 && xhr.status < 300
          ? undefined
          : new AttachmentUploadHttpError(xhr.status),
      ),
    );
    xhr.addEventListener("error", () => finish(new Error("Upload failed")));
    xhr.addEventListener("abort", () => finish(new Error("Upload cancelled")));
    armDeadline(ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
    try {
      xhr.send(input.body);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Upload failed"));
    }
  });
  return { done, abort: () => xhr.abort() };
}
