import {
  DEFAULT_PUBLIC_RELAY_URL,
  normalizeRelayServerUrl,
  type EnvironmentId,
  type RelayHostStatus,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@supacode/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const STATUS_DESCRIPTIONS: Record<RelayHostStatus["state"], string | null> = {
  off: null,
  connecting: "Connecting to the relay server.",
  registered: "Connected. Paired clients can reach this host from anywhere.",
  superseded:
    "Another host is using this relay identity. Turn Public relay off and on to reconnect here.",
  "invalid-url": "The relay server URL is invalid.",
};

export function usePublicRelayStatus(environmentId: EnvironmentId | null): RelayHostStatus | null {
  return (
    useEnvironmentQuery(
      environmentId === null ? null : serverEnvironment.relayStatus({ environmentId, input: {} }),
    ).data ?? null
  );
}

export function PublicRelaySettings({
  status,
  settings,
  disabled,
  update,
}: {
  readonly status: RelayHostStatus | null;
  readonly settings: Pick<ServerSettings, "publicRelayEnabled" | "publicRelayUrl"> | undefined;
  readonly disabled: boolean;
  readonly update: (patch: ServerSettingsPatch) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  const enabled = settings?.publicRelayEnabled ?? false;
  const relayUrl = settings?.publicRelayUrl ?? DEFAULT_PUBLIC_RELAY_URL;
  return (
    <>
      <SettingsRow
        title={searchableSetting("public-relay").title}
        description={
          (enabled && status ? STATUS_DESCRIPTIONS[status.state] : null) ??
          "Connect from anywhere with end-to-end encryption. Enable it, then create a pairing link below."
        }
        control={
          <Switch
            aria-label="Enable public relay"
            disabled={disabled}
            checked={enabled}
            onCheckedChange={(publicRelayEnabled) => update({ publicRelayEnabled })}
          />
        }
      />
      <SettingsRow
        title={searchableSetting("public-relay-server").title}
        description={
          invalid
            ? "Enter a ws:// or wss:// URL."
            : "Run your own relay server instead of the public one. Pairing links carry it to clients."
        }
        resetAction={
          relayUrl !== DEFAULT_PUBLIC_RELAY_URL ? (
            <SettingResetButton
              label="relay server"
              onClick={() => update({ publicRelayUrl: DEFAULT_PUBLIC_RELAY_URL })}
            />
          ) : null
        }
        control={
          <Input
            key={relayUrl}
            aria-label="Relay server URL"
            aria-invalid={invalid}
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            defaultValue={relayUrl}
            placeholder={DEFAULT_PUBLIC_RELAY_URL}
            onChange={() => setInvalid(false)}
            onBlur={(event) => {
              const next = normalizeRelayServerUrl(event.target.value);
              setInvalid(next === null);
              if (next !== null && next !== relayUrl) update({ publicRelayUrl: next });
            }}
          />
        }
      />
    </>
  );
}
