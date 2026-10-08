import * as RelayGateway from "@supacode/client-runtime/relay";
import { PUBLIC_RELAY_URL } from "@supacode/shared/relay/protocol";

export const layer = RelayGateway.layer({
  fetch: (input, init) => globalThis.fetch(input, init),
  open: async (address) => {
    const { default: NativeRelay } = await import("../../modules/supacode-relay-tunnel");
    return {
      prepare: async () =>
        (await NativeRelay.start({ hostAddress: address, relayUrl: PUBLIC_RELAY_URL })).origin,
      close: () => NativeRelay.stop(address),
    };
  },
});
