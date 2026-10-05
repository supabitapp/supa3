import type { EnvironmentId, OrchestrationSkillsStatus } from "@supacode/contracts";
import { useEffect, useRef, useState } from "react";
import type { createServerEnvironmentAtoms } from "@supacode/client-runtime/state/server";
import { useAtomCommand } from "./use-atom-command";
import { orchestrationSkillsView } from "@supacode/client-runtime/orchestrationSkills";

/** Installation is explicit; mounting this hook only reads the native folders. */
export function useOrchestrationSkills(
  environmentId: EnvironmentId,
  commands: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "orchestrationSkillsStatus" | "orchestrationSkillsInstall" | "orchestrationSkillsUninstall"
  >,
) {
  const read = useAtomCommand(commands.orchestrationSkillsStatus, { reportFailure: false });
  const install = useAtomCommand(commands.orchestrationSkillsInstall);
  const uninstall = useAtomCommand(commands.orchestrationSkillsUninstall);
  const [status, setStatus] = useState<OrchestrationSkillsStatus | null>(null);
  const [pending, setPending] = useState<"Status" | "Install" | "Uninstall" | null>("Status");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const request = async (action: "Status" | "Install" | "Uninstall") => {
    if (busy.current) return;
    busy.current = true;
    setPending(action);
    setError(null);
    try {
      const execute = action === "Status" ? read : action === "Install" ? install : uninstall;
      const result = await execute({ environmentId, input: {} });
      if (result._tag === "Success") setStatus(result.value);
      else
        setError(
          "Could not manage skills on this environment. Check its connection and provider folder permissions.",
        );
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  useEffect(() => {
    let active = true;
    busy.current = true;
    void read({ environmentId, input: {} }).then((result) => {
      if (!active) return;
      busy.current = false;
      setPending(null);
      if (result._tag === "Success") setStatus(result.value);
      else setError("Could not read skill installation status on this environment.");
    });
    return () => {
      active = false;
    };
  }, [environmentId, read]);
  return { status, pending, error, request, ...orchestrationSkillsView(status) };
}
