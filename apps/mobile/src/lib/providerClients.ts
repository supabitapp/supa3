import { isProviderDriverKind } from "@supacode/contracts";
import { makeProviderClientRegistry } from "@supacode/provider-core/client";
import { cursorClient } from "@supacode/provider-cursor/client";
import { grokClient } from "@supacode/provider-grok/client";
import { museClient } from "@supacode/provider-muse/client";
import { openCodeClient } from "@supacode/provider-opencode/client";
import { piClient } from "@supacode/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
