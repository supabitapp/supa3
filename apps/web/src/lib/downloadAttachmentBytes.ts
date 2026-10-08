export class AttachmentSourceMissingError extends Error {
  constructor() {
    super("The original attachment expired. Attach it again.");
  }
}

export async function downloadAttachmentBytes(input: {
  readonly url: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}): Promise<File> {
  if (input.sizeBytes <= 0 || input.sizeBytes > input.maxBytes)
    throw new Error("The attachment exceeds the download size limit.");
  const timeout = new AbortController();
  const signal = AbortSignal.any([input.signal, timeout.signal]);
  let timer = setTimeout(
    () => timeout.abort(new Error("The attachment download stalled.")),
    60_000,
  );
  try {
    const response = await fetch(input.url, { signal });
    if (response.status === 404) throw new AttachmentSourceMissingError();
    if (!response.ok || !response.body)
      throw new Error("Downloading the original attachment failed.");
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== input.sizeBytes) {
      await response.body.cancel();
      throw new Error("The original attachment size changed.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        clearTimeout(timer);
        timer = setTimeout(
          () => timeout.abort(new Error("The attachment download stalled.")),
          60_000,
        );
        length += chunk.value.byteLength;
        if (length > input.sizeBytes || length > input.maxBytes)
          throw new Error("The attachment exceeds the download size limit.");
        chunks.push(new Uint8Array(chunk.value));
      }
      if (length !== input.sizeBytes)
        throw new Error("The original attachment download was incomplete.");
      signal.throwIfAborted();
      return new File(chunks, input.name, { type: input.mimeType });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
  }
}
