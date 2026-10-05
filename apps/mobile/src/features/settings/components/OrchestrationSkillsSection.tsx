import type { EnvironmentId } from "@supacode/contracts";
import { useOrchestrationSkills } from "../../../state/useOrchestrationSkills";
import { serverEnvironment } from "../../../state/server";
import { AppText as Text } from "../../../components/AppText";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function OrchestrationSkillsSection({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const skills = useOrchestrationSkills(environmentId, serverEnvironment);
  const busy = skills.pending !== null;
  return (
    <SettingsSection title={`Orchestration skills · ${label}`}>
      <Text className="p-4 text-sm text-foreground-muted">
        Install supacode-commitee and supacode-advisor skills for this environment’s provider
        accounts. Applies to all projects and updates with Supacode. Restart existing agent sessions
        to load skill changes.
      </Text>
      <SettingsRow
        icon="arrow.down.circle"
        label={
          skills.installed
            ? "Installed"
            : skills.pending === "Install"
              ? "Installing…"
              : "Install Skills"
        }
        disabled={busy || !skills.canInstall}
        onPress={() => void skills.request("Install")}
      />
      {skills.canUninstall ? (
        <SettingsRow
          icon="trash"
          label={skills.pending === "Uninstall" ? "Uninstalling…" : "Uninstall Skills"}
          disabled={busy}
          onPress={() => void skills.request("Uninstall")}
        />
      ) : null}
      {skills.conflicts.map((target) => (
        <Text key={target.directory} className="p-4 text-sm text-foreground-muted">
          Existing skill folders or unrelated links in {target.directory} were left unchanged.
        </Text>
      ))}
      {skills.status?.targets.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          No providers support native skill installation here.
        </Text>
      ) : null}
      {skills.status && skills.status.unsupportedProviders.length > 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          Not supported: {skills.status.unsupportedProviders.join(", ")}.
        </Text>
      ) : null}
      {skills.error ? (
        <SettingsRow
          icon="arrow.clockwise"
          label="Retry"
          value={skills.error}
          disabled={busy}
          onPress={() => void skills.request("Status")}
        />
      ) : null}
    </SettingsSection>
  );
}
