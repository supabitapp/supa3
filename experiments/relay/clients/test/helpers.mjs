import { startRelay } from '../lib/relay.mjs';

export function useRelay(test, env = {}) {
  const ctx = {};
  test.before(async () => { ctx.relay = await startRelay(env); });
  test.after(async () => { await ctx.relay.stop(); });
  return ctx;
}

export async function expectRejected(promise, status) {
  try {
    const ws = await promise;
    ws.terminate();
  } catch (err) {
    if (err.status !== status) throw new Error(`expected HTTP ${status}, got ${err.status ?? err.message}`);
    return err;
  }
  throw new Error(`expected HTTP ${status} rejection, but the socket opened`);
}
