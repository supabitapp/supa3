import type { EnvironmentId } from "@supacode/contracts";
import { useOrchestrationSkills } from "../../state/useOrchestrationSkills";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function EnvironmentSkills({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const skills = useOrchestrationSkills(environmentId, serverEnvironment);
  const busy = skills.pending !== null;
  return (
    <SettingsRow
      title={label}
      description={
        <>
          Install supacode-commitee and supacode-advisor skills for this environment’s provider
          accounts. Applies to all projects and updates with Supacode.
          {skills.installed ? (
            <span className="block">
              Installed. Restart existing agent sessions to load skill changes.
            </span>
          ) : null}
          {skills.status?.targets.length === 0 ? (
            <span className="block">No providers support native skill installation here.</span>
          ) : null}
          {skills.status && skills.status.unsupportedProviders.length > 0 ? (
            <span className="block">
              Not supported: {skills.status.unsupportedProviders.join(", ")}.
            </span>
          ) : null}
          {skills.conflicts.map((target) => (
            <span className="block" key={target.directory}>
              Existing skill folders or unrelated links in {target.directory} were left unchanged.
            </span>
          ))}
          {skills.error ? (
            <span className="block" role="alert">
              {skills.error}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          {skills.canUninstall ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void skills.request("Uninstall")}
            >
              {skills.pending === "Uninstall" ? "Uninstalling…" : "Uninstall Skills"}
            </Button>
          ) : null}
          {skills.installed ? (
            <span className="text-sm text-muted-foreground">Installed</span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !skills.canInstall}
              onClick={() => void skills.request("Install")}
            >
              {skills.pending === "Install" ? "Installing…" : "Install Skills"}
            </Button>
          )}
          {skills.error ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void skills.request("Status")}
            >
              Retry
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function OrchestrationSkillsSettings() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsSection {...searchableSetting("orchestration-skills")}>
      {connectedEnvironments.length === 0 ? (
        <SettingsRow
          title="Install Skills"
          description="Connect to an environment to install supacode-commitee and supacode-advisor skills."
        />
      ) : null}
      {connectedEnvironments.map((environment) => (
        <EnvironmentSkills
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </SettingsSection>
  );
}
