import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@supacode/contracts";
import { acpRegistryClient } from "@supacode/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@supacode/provider-core/client";
import { cursorClient } from "@supacode/provider-cursor/client";
import { grokClient } from "@supacode/provider-grok/client";
import { museClient } from "@supacode/provider-muse/client";
import { openCodeClient } from "@supacode/provider-opencode/client";
import { piClient } from "@supacode/provider-pi/client";

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
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
