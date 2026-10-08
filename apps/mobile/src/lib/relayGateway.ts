import * as RelayGateway from "@supacode/client-runtime/relay";
import { PUBLIC_RELAY_URL } from "@supacode/shared/relay/protocol";
import NativeRelay from "../../modules/supacode-relay-tunnel";

export const layer = RelayGateway.layer({
  fetch: (input, init) => globalThis.fetch(input, init),
  open: async (address) => ({
    prepare: async () =>
      (await NativeRelay.start({ hostAddress: address, relayUrl: PUBLIC_RELAY_URL })).origin,
    close: () => NativeRelay.stop(address),
  }),
});
