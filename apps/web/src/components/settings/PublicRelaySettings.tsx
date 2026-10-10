import {
  DEFAULT_PUBLIC_RELAY_URL,
  normalizeRelayServerUrl,
  type EnvironmentId,
  type RelayHostStatus,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@supacode/contracts";
import { relayName } from "@supacode/shared/relay/name";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function statusDescription(status: RelayHostStatus): string | null {
  const name = status.relayEndpoint === undefined ? null : relayName(status.relayEndpoint);
  switch (status.state) {
    case "off":
      return null;
    case "idle":
      return "Ready to link a device. Use Add device below to create a pairing link.";
    case "connecting":
      return "Preparing your connection…";
    case "registered":
      return name === null
        ? "Connected. Paired clients can reach this host from anywhere."
        : `Connected as ${name}. Paired clients can reach this host from anywhere.`;
    case "superseded":
      return "Another host is using this relay identity. Turn Public relay off and on to reconnect here.";
    case "invalid-url":
      return "The relay server URL is invalid.";
  }
}

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
          (enabled && status ? statusDescription(status) : null) ??
          "Connect your other devices from anywhere with end-to-end encryption. Turn it on, then use Add device below."
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
