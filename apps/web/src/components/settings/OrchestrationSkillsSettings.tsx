import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
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
          <span className="block">Restart existing agent sessions to load skill changes.</span>
          {skills.notices.map((notice) => (
            <span className="block" key={notice}>
              {notice}
            </span>
          ))}
        </>
      }
      control={
        <div className="flex min-h-11 min-w-40 items-center justify-end gap-2">
          {skills.installed ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="comfortable"
                    disabled={busy || !skills.canUninstall}
                  />
                }
              >
                <CheckIcon aria-hidden="true" />
                {skills.pending === "Uninstall" ? "Uninstalling…" : "Installed"}
                <ChevronDownIcon aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  disabled={busy || !skills.canUninstall}
                  onClick={() => void skills.request("Uninstall")}
                >
                  Uninstall Skills
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : (
            <>
              <Button
                variant="outline"
                size="comfortable"
                disabled={busy || !skills.canInstall}
                onClick={() => void skills.request("Install")}
              >
                {skills.pending === "Status"
                  ? "Checking…"
                  : skills.pending === "Install"
                    ? "Installing…"
                    : "Install Skills"}
              </Button>
              {skills.canUninstall ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="comfortable"
                        disabled={busy || !skills.canUninstall}
                      />
                    }
                  >
                    {skills.pending === "Uninstall" ? "Uninstalling…" : "Manage"}
                    <ChevronDownIcon aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      disabled={busy || !skills.canUninstall}
                      onClick={() => void skills.request("Uninstall")}
                    >
                      Uninstall Skills
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </>
          )}
          {skills.error ? (
            <Button
              variant="outline"
              size="comfortable"
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
