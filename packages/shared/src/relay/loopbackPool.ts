import { canonicalRelayAddress } from "./protocol.ts";

export interface LoopbackRelay {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

interface Lease {
  pending: number;
  retained: boolean;
}

interface Endpoint {
  readonly resource: Promise<LoopbackRelay>;
  readonly owners: Map<string, Lease>;
  closing?: Promise<void>;
}

export function createLoopbackRelayPool(input: {
  readonly open: (address: string, relayUrl: string) => Promise<LoopbackRelay>;
  readonly limit: number;
}) {
  const endpoints = new Map<string, Endpoint>();
  const closing = new Set<Promise<void>>();
  let disposed = false;
  const canonical = (address: string) => {
    const identity = canonicalRelayAddress(address);
    if (!identity) throw new Error("Not a relay address");
    return identity;
  };
  const closeResource = (address: string, endpoint: Endpoint) => {
    if (!endpoint.closing) {
      const closed = endpoint.resource
        .then(
          (value) => value.close(),
          () => {},
        )
        .finally(() => {
          if (endpoints.get(address) === endpoint) endpoints.delete(address);
          closing.delete(closed);
        });
      endpoint.closing = closed;
      closing.add(closed);
    }
    return endpoint.closing;
  };
  const release = async (address: string, owner: string) => {
    const identity = canonical(address);
    const endpoint = endpoints.get(identity);
    if (!endpoint?.owners.delete(owner)) return;
    if (endpoint.owners.size === 0) await closeResource(identity, endpoint);
  };
  const acquire = async (
    address: string,
    owner: string,
    relayUrl: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const identity = canonical(address);
    signal?.throwIfAborted();
    if (disposed) throw new Error("Relay gateway is closed");
    const saved = endpoints.get(identity);
    let endpoint = saved;
    if (!endpoint || endpoint.closing) {
      if (!saved && endpoints.size >= input.limit) throw new Error("Too many relay environments");
      const created: Endpoint = {
        resource: (saved?.closing ?? Promise.resolve())
          .catch(() => {})
          .then(() => {
            if (disposed || created.closing || endpoints.get(identity) !== created)
              throw new Error("Relay endpoint was closed before preparation");
            return input.open(identity, relayUrl);
          })
          .catch((error) => {
            if (endpoints.get(identity) === created) endpoints.delete(identity);
            throw error;
          }),
        owners: new Map(),
      };
      endpoints.set(identity, created);
      endpoint = created;
    }
    const selected = endpoint;
    const lease = selected.owners.get(owner) ?? { pending: 0, retained: false };
    selected.owners.set(owner, lease);
    lease.pending++;
    let pending = true;
    const finish = (retained = false) => {
      if (!pending) return;
      pending = false;
      lease.pending--;
      if (retained) lease.retained = true;
      if (!lease.retained && lease.pending === 0 && selected.owners.get(owner) === lease) {
        selected.owners.delete(owner);
        if (selected.owners.size === 0) void closeResource(identity, selected).catch(() => {});
      }
    };
    const cancel = () => finish();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const resource = await selected.resource;
      signal?.throwIfAborted();
      if (
        disposed ||
        selected.closing ||
        endpoints.get(identity) !== selected ||
        selected.owners.get(owner) !== lease
      )
        throw new Error("Relay endpoint was closed during preparation");
      finish(true);
      return resource.origin;
    } finally {
      signal?.removeEventListener("abort", cancel);
      finish();
    }
  };
  return {
    acquire,
    release,
    releaseOwner: async (owner: string) => {
      await Promise.all(
        [...endpoints].flatMap(([address, endpoint]) =>
          endpoint.owners.has(owner) ? [release(address, owner)] : [],
        ),
      );
    },
    dispose: async () => {
      disposed = true;
      await Promise.allSettled([
        ...[...endpoints].map(([address, endpoint]) => closeResource(address, endpoint)),
        ...closing,
      ]);
    },
  };
}
