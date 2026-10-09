import {
  AcpRegistrySettings,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  GrokSettings,
  ProviderDriverKind,
} from "@supacode/contracts";
import { makeProviderClientRegistry } from "@supacode/provider-core/client";
import { cursorClient } from "@supacode/provider-cursor/client";
import { museClient } from "@supacode/provider-muse/client";
import { openCodeClient } from "@supacode/provider-opencode/client";
import { piClient } from "@supacode/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  {
    driverKind: ProviderDriverKind.make("grok"),
    label: "Grok",
    settingsSchema: GrokSettings,
  },
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  {
    driverKind: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    settingsSchema: AcpRegistrySettings,
    hasDefaultInstance: false,
  },
]);
