import { relayFetch, relayClientOptions } from "@supacode/client-runtime/rpc";
import * as ExpoCrypto from "expo-crypto";

export const fetchRelay = relayFetch(
  (input, init) => globalThis.fetch(input, init),
  relayClientOptions(ExpoCrypto.getRandomBytes),
);
