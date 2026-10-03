import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  acceptClientHandshake,
  createClientHandshake,
  createRelayStream,
  parseRelayAddress,
  relayHttpBaseUrl,
  relayPublicKey,
} from "./protocol.ts";

const exchange = () => {
  const identity = NodeCrypto.randomBytes(32);
  const client = createClientHandshake(relayPublicKey(identity), NodeCrypto.randomBytes);
  const host = acceptClientHandshake(client.hello, identity, NodeCrypto.randomBytes);
  return { client: client.finish(host.welcome), host: host.cipher };
};
describe("encrypted relay protocol", () => {
  it("bounds in-flight data while both peers send fragmented messages", () => {
    const pair = exchange();
    const toHost: Uint8Array[] = [];
    const toClient: Uint8Array[] = [];
    const client = createRelayStream(pair.client, (frame) => toHost.push(frame));
    const host = createRelayStream(pair.host, (frame) => toClient.push(frame));
    const payload = "x".repeat(2_000_000);
    client.send(payload);
    client.send("next");
    host.send(payload + "reply");
    expect(toHost).toHaveLength(8);
    expect(toClient).toHaveLength(8);
    const receivedByHost: string[] = [];
    const receivedByClient: string[] = [];
    while (toHost.length || toClient.length) {
      const request = toHost.shift();
      if (request) {
        const value = host.receive(request);
        if (value !== null) receivedByHost.push(value);
      }
      const response = toClient.shift();
      if (response) {
        const value = client.receive(response);
        if (value !== null) receivedByClient.push(value);
      }
      expect(toHost.length + toClient.length).toBeLessThanOrEqual(32);
    }
    expect(receivedByHost).toEqual([payload, "next"]);
    expect(receivedByClient).toEqual([payload + "reply"]);
    client.destroy();
    expect(() => client.send("closed")).toThrow();
  });
  it("pins the host key in a normalized address", () => {
    const publicKey = relayPublicKey(NodeCrypto.randomBytes(32));
    expect(parseRelayAddress(relayHttpBaseUrl(publicKey))).toEqual(publicKey);
    expect(parseRelayAddress("https://example.com/")).toBeNull();
    expect(() => parseRelayAddress("https://bad.relay.supacode.invalid/")).toThrow();
  });
  it("preserves large messages, empty messages, unicode and separate directions", () => {
    const { client, host } = exchange();
    for (const value of ["", "hello 🌎", "x".repeat(1_000_000)]) {
      const frames = [...client.encode(value)];
      expect(frames.slice(0, -1).map((frame) => host.decode(frame))).toEqual(
        frames.slice(0, -1).map(() => null),
      );
      expect(host.decode(frames.at(-1)!)).toBe(value);
      expect(client.decode([...host.encode("reply")][0]!)).toBe("reply");
    }
  });
  it("rejects an impostor and a handshake from another connection", () => {
    const identity = NodeCrypto.randomBytes(32);
    const first = createClientHandshake(relayPublicKey(identity), NodeCrypto.randomBytes);
    const second = createClientHandshake(relayPublicKey(identity), NodeCrypto.randomBytes);
    const wrong = acceptClientHandshake(
      first.hello,
      NodeCrypto.randomBytes(32),
      NodeCrypto.randomBytes,
    );
    expect(() => first.finish(wrong.welcome)).toThrow();
    const correct = acceptClientHandshake(first.hello, identity, NodeCrypto.randomBytes);
    expect(() => second.finish(correct.welcome)).toThrow();
  });
  it("rejects repeated, reordered, reflected, modified and old-session ciphertext", () => {
    const { client, host } = exchange();
    const first = [...client.encode("command")][0]!;
    const second = [...client.encode("next")][0]!;
    expect(() => host.decode(second)).toThrow();
    expect(host.decode(first)).toBe("command");
    expect(() => host.decode(first)).toThrow();
    const altered = second.slice();
    altered[altered.length - 1]! ^= 1;
    expect(() => host.decode(altered)).toThrow();
    expect(host.decode(second)).toBe("next");
    expect(() => client.decode(first)).toThrow();
    expect(() => exchange().host.decode(first)).toThrow();
    host.destroy();
    expect(() => [...host.encode("closed")]).toThrow();
  });
});
