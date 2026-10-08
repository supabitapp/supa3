// @effect-diagnostics nodeBuiltinImport:off - validates native loopback HTTP streams without rewriting their bytes.
import * as NodeStream from "node:stream";
import { after } from "./timer.ts";

const delimiter = Buffer.from("\r\n\r\n");
const lineEnding = Buffer.from("\r\n");
const headerLimit = 16 * 1024;
const fieldName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
type Phase =
  | "headers"
  | "body"
  | "chunk-size"
  | "chunk"
  | "chunk-crlf"
  | "trailers"
  | "upgrade"
  | "opaque";

function fields(lines: string[]) {
  const result = new Map<string, string[]>();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).toLowerCase();
    if (colon <= 0 || !fieldName.test(name)) throw new Error("Invalid HTTP header");
    result.set(name, [...(result.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return result;
}

export class HttpHostGuard extends NodeStream.Transform {
  private readonly authority: string;
  private phase: Phase = "headers";
  private buffered: Buffer = Buffer.alloc(0);
  private response: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private requests = 0;
  private waiting: NodeStream.TransformCallback | undefined;
  private cancelUpgrade: (() => void) | undefined;

  constructor(authority: string) {
    super();
    this.authority = authority;
  }

  get awaitingUpgrade() {
    return this.phase === "upgrade";
  }

  startUpgradeTimeout() {
    if (this.awaitingUpgrade)
      this.cancelUpgrade = after(15_000, () => this.destroy(new Error("HTTP upgrade timed out")));
  }

  override _transform(
    bytes: Buffer,
    _encoding: BufferEncoding,
    callback: NodeStream.TransformCallback,
  ) {
    try {
      this.buffered = this.buffered.length === 0 ? bytes : Buffer.concat([this.buffered, bytes]);
      this.forward();
      if (this.phase === "upgrade") {
        this.waiting = callback;
      } else callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Invalid loopback HTTP"));
    }
  }

  observeResponse(bytes: Buffer) {
    if (this.phase !== "upgrade") return;
    try {
      this.response = this.response.length === 0 ? bytes : Buffer.concat([this.response, bytes]);
      while (true) {
        const end = this.response.indexOf(delimiter);
        if (end < 0) {
          if (this.response.length > 64 * 1024) throw new Error("HTTP response headers too large");
          return;
        }
        if (end + 4 > 64 * 1024) throw new Error("HTTP response headers too large");
        const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |\r\n)/.exec(
          this.response.toString("latin1", 0, end + 4),
        )?.[1];
        if (!status || Number(status) < 100 || Number(status) >= 600)
          throw new Error("Invalid HTTP response");
        this.response = this.response.subarray(end + 4);
        if (Number(status) >= 100 && Number(status) < 200 && status !== "101") continue;
        this.phase = status === "101" ? "opaque" : "headers";
        this.response = Buffer.alloc(0);
        this.cancelUpgrade?.();
        this.cancelUpgrade = undefined;
        this.forward();
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting?.();
        return;
      }
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error("Invalid HTTP response"));
    }
  }

  private forwardBytes(count: number) {
    this.push(this.buffered.subarray(0, count));
    this.buffered = this.buffered.subarray(count);
  }

  private forward() {
    while (this.buffered.length > 0) {
      switch (this.phase) {
        case "opaque":
          this.forwardBytes(this.buffered.length);
          break;
        case "upgrade":
          return;
        case "headers": {
          const end = this.buffered.indexOf(delimiter);
          if (end < 0) {
            if (this.buffered.length > headerLimit) throw new Error("HTTP headers too large");
            return;
          }
          if (end + 4 > headerLimit) throw new Error("HTTP headers too large");
          const [request, ...lines] = this.buffered.toString("latin1", 0, end).split("\r\n");
          if (!request || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+ \/(?!\/)[!-~]* HTTP\/1\.1$/.test(request))
            throw new Error("Invalid HTTP request target");
          const headers = fields(lines);
          const host = headers.get("host");
          if (host?.length !== 1 || host[0] !== this.authority)
            throw new Error("Misdirected HTTP Host");
          const lengths = headers.get("content-length");
          const transfer = headers.get("transfer-encoding");
          if (lengths && (lengths.length !== 1 || transfer)) throw new Error("Ambiguous HTTP body");
          if (transfer && (transfer.length !== 1 || transfer[0]?.toLowerCase() !== "chunked"))
            throw new Error("Unsupported HTTP body");
          const length = lengths?.[0] ?? "0";
          if (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)))
            throw new Error("Invalid HTTP length");
          this.remaining = Number(length);
          if (headers.has("upgrade")) {
            if (this.requests !== 0 || this.remaining !== 0 || transfer)
              throw new Error("Upgrade requires a fresh connection");
            this.phase = "upgrade";
          } else if (transfer) this.phase = "chunk-size";
          else this.phase = this.remaining > 0 ? "body" : "headers";
          this.requests++;
          this.forwardBytes(end + 4);
          break;
        }
        case "body":
        case "chunk": {
          const count = Math.min(this.remaining, this.buffered.length);
          this.remaining -= count;
          this.forwardBytes(count);
          if (this.remaining === 0) this.phase = this.phase === "body" ? "headers" : "chunk-crlf";
          break;
        }
        case "chunk-size": {
          const end = this.buffered.indexOf(lineEnding);
          if (end < 0) {
            if (this.buffered.length > 1024) throw new Error("HTTP chunk line too large");
            return;
          }
          if (end + 2 > 1024) throw new Error("HTTP chunk line too large");
          const size = this.buffered.toString("latin1", 0, end).split(";")[0]!;
          if (!/^[0-9a-fA-F]+$/.test(size) || !Number.isSafeInteger(Number.parseInt(size, 16)))
            throw new Error("Invalid HTTP chunk");
          this.remaining = Number.parseInt(size, 16);
          this.forwardBytes(end + 2);
          this.phase = this.remaining === 0 ? "trailers" : "chunk";
          break;
        }
        case "chunk-crlf":
          if (this.buffered.length < 2) return;
          if (!this.buffered.subarray(0, 2).equals(lineEnding))
            throw new Error("Invalid HTTP chunk ending");
          this.forwardBytes(2);
          this.phase = "chunk-size";
          break;
        case "trailers": {
          if (this.buffered.length >= 2 && this.buffered.subarray(0, 2).equals(lineEnding)) {
            this.forwardBytes(2);
            this.phase = "headers";
            break;
          }
          const end = this.buffered.indexOf(delimiter);
          if (end < 0) {
            if (this.buffered.length > headerLimit) throw new Error("HTTP trailers too large");
            return;
          }
          if (end + 4 > headerLimit) throw new Error("HTTP trailers too large");
          fields(this.buffered.toString("latin1", 0, end).split("\r\n"));
          this.forwardBytes(end + 4);
          this.phase = "headers";
          break;
        }
      }
    }
  }

  override _flush(callback: NodeStream.TransformCallback) {
    callback(
      this.buffered.length === 0 && ["headers", "opaque"].includes(this.phase)
        ? undefined
        : new Error("Truncated HTTP request"),
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.cancelUpgrade?.();
    this.waiting = undefined;
    callback(error);
  }
}
