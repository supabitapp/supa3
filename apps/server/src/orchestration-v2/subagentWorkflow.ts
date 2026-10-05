import type { OrchestrationV2Subagent, OrchestrationV2SubagentWorkflow } from "@supacode/contracts";

/** Keep observed member outcomes when the coordinator's process stops. */
export function settleSubagentWorkflow(
  workflow: OrchestrationV2SubagentWorkflow | undefined,
  status: OrchestrationV2Subagent["status"],
): OrchestrationV2SubagentWorkflow | undefined {
  if (
    workflow === undefined ||
    status === "pending" ||
    status === "running" ||
    status === "waiting" ||
    status === "idle"
  ) {
    return workflow;
  }
  return {
    ...workflow,
    agents: workflow.agents.map((agent) => {
      if (agent.state !== "queued" && agent.state !== "running") return agent;
      return {
        ...agent,
        state:
          status === "completed" && agent.state === "running"
            ? "completed"
            : status === "interrupted"
              ? "interrupted"
              : "cancelled",
      };
    }),
  };
}
