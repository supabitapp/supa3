import crypto from 'node:crypto';
import { b64url } from './util.mjs';

export function generateHostKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    privateKey,
    publicKeyRaw: raw,
    publicKey: b64url(raw),
    endpointId: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

export function challengeMessage(endpointId, nonce) {
  return Buffer.from(`passio-relay-v1\n${endpointId}\n${nonce}`, 'utf8');
}

export function signChallenge(key, nonce) {
  return b64url(crypto.sign(null, challengeMessage(key.endpointId, nonce), key.privateKey));
}

export const urls = {
  control: (address, publicKey) => `ws://${address}/v1/control?publicKey=${publicKey}`,
  connect: (address, endpointId) => `ws://${address}/v1/connect?endpointId=${endpointId}`,
  accept: (address, endpointId, connectionId, token) =>
    `ws://${address}/v1/accept?endpointId=${endpointId}&connectionId=${encodeURIComponent(connectionId)}&token=${encodeURIComponent(token)}`,
};
