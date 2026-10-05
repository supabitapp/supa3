import type { OrchestrationSkillsEnvironment } from "@supacode/client-runtime/orchestrationSkills";
import { useOrchestrationSkills } from "../../state/useOrchestrationSkills";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function SelectedEnvironmentSkills({
  environments,
}: {
  environments: readonly OrchestrationSkillsEnvironment[];
}) {
  const skills = useOrchestrationSkills(environments, serverEnvironment);
  const busy = skills.pending !== null;
  return (
    <SettingsRow
      title="Orchestration skills"
      description={
        <>
          Install supacode-commitee and supacode-advisor skills for the selected environments’
          provider accounts. Applies to all projects and updates with Supacode.
          {skills.installed ? (
            <span className="block">
              Installed. Restart existing agent sessions to load skill changes.
            </span>
          ) : null}
          {skills.notices.map((notice) => (
            <span className="block" key={notice}>
              {notice}
            </span>
          ))}
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
  const { environments, connectedEnvironments } = useSettingsScope();
  const offline = environments.filter(
    (environment) =>
      !connectedEnvironments.some(
        (connected) => connected.environmentId === environment.environmentId,
      ),
  );
  return (
    <SettingsSection {...searchableSetting("orchestration-skills")}>
      {connectedEnvironments.length === 0 ? (
        <SettingsRow
          title="Orchestration skills"
          description="Connect to an environment to install supacode-commitee and supacode-advisor skills."
        />
      ) : (
        <SelectedEnvironmentSkills
          key={connectedEnvironments
            .map((environment) => environment.environmentId)
            .sort()
            .join(",")}
          environments={connectedEnvironments}
        />
      )}
      {offline.length > 0 ? (
        <SettingsRow
          title="Offline environments"
          description={`Skipped: ${offline.map((environment) => environment.label).join(", ")}. Reconnect and install again to include them.`}
        />
      ) : null}
    </SettingsSection>
  );
}
