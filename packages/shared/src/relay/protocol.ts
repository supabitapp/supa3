import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import * as Schema from "effect/Schema";

export const PUBLIC_RELAY_URL = "wss://supacode-relay.exe.xyz";
const suffix = ".relay.supacode.invalid";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_RELAY_MESSAGE_BYTES = 80 * 1024 * 1024;
const CHUNK_BYTES = 48 * 1024;
const acknowledgement = Symbol("relay-acknowledgement");

export const encodeBase64 = (data: Uint8Array): string => {
  let value = "";
  for (let i = 0; i < data.length; i += 8192) {
    value += String.fromCharCode(...data.subarray(i, i + 8192));
  }
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
export const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid relay encoding");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
};
export const relayPublicKey = (secret: Uint8Array) => ed25519.getPublicKey(secret);
export const relayEndpointId = (publicKey: Uint8Array) => bytesToHex(sha256(publicKey));
export const relayHttpBaseUrl = (publicKey: Uint8Array) => {
  const hex = bytesToHex(publicKey);
  return `https://${hex.slice(0, 32)}.${hex.slice(32)}${suffix}/`;
};
export const parseRelayAddress = (input: string): Uint8Array | null => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(suffix)) return null;
  if (!["https:", "wss:"].includes(url.protocol) || url.port || url.username || url.password) {
    throw new Error("Invalid relay address");
  }
  const key = url.hostname.slice(0, -suffix.length);
  if (!/^[0-9a-f]{32}\.[0-9a-f]{32}$/.test(key)) throw new Error("Invalid relay identity");
  return hexToBytes(key.replace(".", ""));
};
export const signRelayChallenge = (secret: Uint8Array, nonce: string) =>
  encodeBase64(
    ed25519.sign(
      encoder.encode(`supacode-relay-v1\n${relayEndpointId(relayPublicKey(secret))}\n${nonce}`),
      secret,
    ),
  );

const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  version: Schema.Literal(1),
  key: Schema.String,
});
const Welcome = Schema.Struct({
  type: Schema.Literal("welcome"),
  version: Schema.Literal(1),
  key: Schema.String,
  signature: Schema.String,
});
const decodeHello = Schema.decodeUnknownSync(Hello);
const decodeWelcome = Schema.decodeUnknownSync(Welcome);
const keyBytes = (value: string) => {
  const key = decodeBase64(value);
  if (key.length !== 32) throw new Error("Invalid relay key");
  return key;
};
const transcript = (identity: Uint8Array, client: Uint8Array, host: Uint8Array) =>
  concatBytes(encoder.encode("supacode-tunnel-v1\n"), identity, client, host);

function createRelayCipher(shared: Uint8Array, context: Uint8Array, host: boolean) {
  const keys = hkdf(
    sha256,
    shared,
    sha256(context),
    encoder.encode("supacode-tunnel-traffic-v1"),
    64,
  );
  shared.fill(0);
  const sendKey = keys.slice(host ? 32 : 0, host ? 64 : 32);
  const receiveKey = keys.slice(host ? 0 : 32, host ? 32 : 64);
  keys.fill(0);
  let sent = 0n;
  let received = 0n;
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let destroyed = false;
  const encrypt = (plain: Uint8Array) => {
    if (destroyed) throw new Error("Relay channel closed");
    if (sent >= 1n << 64n) throw new Error("Relay sequence exhausted");
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, sent++);
    return Uint8Array.from(
      concatBytes(nonce.subarray(4), chacha20poly1305(sendKey, nonce).encrypt(plain)),
    );
  };
  return {
    *encode(value: string) {
      if (destroyed) throw new Error("Relay channel closed");
      const data = encoder.encode(value);
      if (data.length > MAX_RELAY_MESSAGE_BYTES) throw new Error("Relay message too large");
      for (let offset = 0; offset < Math.max(data.length, 1); offset += CHUNK_BYTES) {
        const final = offset + CHUNK_BYTES >= data.length;
        const plain = concatBytes(
          Uint8Array.of(final ? 1 : 0),
          data.subarray(offset, offset + CHUNK_BYTES),
        );
        yield encrypt(plain);
      }
    },
    acknowledge: () => encrypt(Uint8Array.of(2)),
    decode(frame: Uint8Array): string | null | typeof acknowledgement {
      if (destroyed || frame.length < 25 || frame.length > CHUNK_BYTES + 25)
        throw new Error("Invalid relay frame");
      const sequence = new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0);
      if (sequence !== received) throw new Error("Relay frame out of order");
      const nonce = new Uint8Array(12);
      nonce.set(frame.subarray(0, 8), 4);
      const plain = chacha20poly1305(receiveKey, nonce).decrypt(frame.subarray(8));
      received++;
      if (plain[0] === 2 && plain.length === 1) return acknowledgement;
      if (plain[0] !== 0 && plain[0] !== 1) throw new Error("Invalid relay fragment");
      bufferedBytes += plain.length - 1;
      if (bufferedBytes > MAX_RELAY_MESSAGE_BYTES) throw new Error("Relay message too large");
      buffered.push(plain.subarray(1));
      if (plain[0] === 0) return null;
      const message = decoder.decode(concatBytes(...buffered));
      buffered = [];
      bufferedBytes = 0;
      return message;
    },
    destroy() {
      destroyed = true;
      sendKey.fill(0);
      receiveKey.fill(0);
      buffered = [];
      bufferedBytes = 0;
    },
  };
}
export type RelayCipher = ReturnType<typeof createRelayCipher>;

export function createRelayStream(
  cipher: RelayCipher,
  write: (frame: Uint8Array<ArrayBuffer>) => void,
) {
  const queue: { frames: ReturnType<RelayCipher["encode"]>; size: number }[] = [];
  let queued = 0;
  let outstanding = 0;
  let closed = false;
  const flush = () => {
    while (outstanding < 8 && queue.length > 0) {
      const next = queue[0]!;
      const frame = next.frames.next();
      if (frame.done) {
        queued -= next.size;
        queue.shift();
      } else {
        outstanding++;
        write(frame.value);
      }
    }
  };
  return {
    send(value: string) {
      if (closed) throw new Error("Relay channel closed");
      if (queued + value.length > MAX_RELAY_MESSAGE_BYTES) throw new Error("Relay send queue full");
      queued += value.length;
      queue.push({ frames: cipher.encode(value), size: value.length });
      flush();
    },
    receive(frame: Uint8Array) {
      const result = cipher.decode(frame);
      if (result === acknowledgement) {
        if (outstanding === 0) throw new Error("Unexpected relay acknowledgement");
        outstanding--;
        flush();
        return null;
      }
      write(cipher.acknowledge());
      return result;
    },
    destroy() {
      closed = true;
      queue.length = 0;
      queued = 0;
      cipher.destroy();
    },
  };
}
export type RelayStream = ReturnType<typeof createRelayStream>;

export function createClientHandshake(
  identity: Uint8Array,
  randomBytes: (size: number) => Uint8Array,
) {
  const secret = randomBytes(32);
  const publicKey = x25519.getPublicKey(secret);
  return {
    hello: JSON.stringify({ type: "hello", version: 1, key: encodeBase64(publicKey) }),
    finish(raw: string) {
      try {
        const welcome = decodeWelcome(JSON.parse(raw));
        const host = keyBytes(welcome.key);
        const context = transcript(identity, publicKey, host);
        if (
          !ed25519.verify(decodeBase64(welcome.signature), context, identity, { zip215: false })
        ) {
          throw new Error("Relay host identity mismatch");
        }
        return createRelayCipher(x25519.getSharedSecret(secret, host), context, false);
      } finally {
        secret.fill(0);
      }
    },
    destroy() {
      secret.fill(0);
    },
  };
}
export function acceptClientHandshake(
  raw: string,
  identitySecret: Uint8Array,
  randomBytes: (size: number) => Uint8Array,
) {
  const hello = decodeHello(JSON.parse(raw));
  const client = keyBytes(hello.key);
  const secret = randomBytes(32);
  try {
    const publicKey = x25519.getPublicKey(secret);
    const context = transcript(relayPublicKey(identitySecret), client, publicKey);
    return {
      welcome: JSON.stringify({
        type: "welcome",
        version: 1,
        key: encodeBase64(publicKey),
        signature: encodeBase64(ed25519.sign(context, identitySecret)),
      }),
      cipher: createRelayCipher(x25519.getSharedSecret(secret, client), context, true),
    };
  } finally {
    secret.fill(0);
  }
}
