export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline ${ms}ms exceeded: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function once(emitter, event, ms = 5000) {
  return withDeadline(new Promise((resolve, reject) => {
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => { emitter.off(event, onEvent); emitter.off('error', onError); };
    emitter.on(event, onEvent);
    if (event !== 'error') emitter.on('error', onError);
  }), ms, `event ${event}`);
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}
