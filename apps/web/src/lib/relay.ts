import { relayFetch } from "@t3tools/client-runtime/rpc";

export const fetchRelay = relayFetch((input, init) => globalThis.fetch(input, init));
