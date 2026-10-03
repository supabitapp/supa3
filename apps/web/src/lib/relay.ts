import { relayFetch } from "@supacode/client-runtime/rpc";

export const fetchRelay = relayFetch((input, init) => globalThis.fetch(input, init));
