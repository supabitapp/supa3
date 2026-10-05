import type { OrchestrationSkillsStatus } from "@supacode/contracts";

export function orchestrationSkillsView(status: OrchestrationSkillsStatus | null) {
  const skills = status?.targets.flatMap((target) => target.skills) ?? [];
  return {
    canInstall: skills.some(
      (skill) => skill.state === "not-installed" || skill.state === "update-available",
    ),
    canUninstall: skills.some((skill) => skill.managed && skill.state !== "conflict"),
    installed: skills.length > 0 && skills.every((skill) => skill.state === "installed"),
    conflicts:
      status?.targets.filter((target) =>
        target.skills.some((skill) => skill.state === "conflict"),
      ) ?? [],
  };
}
