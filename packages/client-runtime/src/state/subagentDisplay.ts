import type {
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@supacode/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@supacode/shared/model";
import { formatDuration } from "@supacode/shared/orchestrationTiming";
import { formatTokens } from "@supacode/shared/usageFormat";
import { fileBasename } from "../markdownLinks.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

/** Summarizes one adjacent group, without changing its member identities or order. */
export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

/**
 * Counts a group's states in the order a reader scans them: what is still
 * running first, then outcomes, using the agents panel's words.
 */
export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

/** Formats Codex task paths for display while leaving provider identity untouched. */
export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

/** Match desktop's model resolution and show only changes from the parent's workspace. */
export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | null
    | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">
    | null
    | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | null | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | null
    | undefined;
}) {
  const model = input.model?.trim();
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, model, input.provider.models)
    : model;
  const catalogModel = input.provider?.models.find((candidate) => candidate.slug === slug);
  const reportedLabel = catalogModel
    ? catalogModel.shortName || catalogModel.name
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const qualifier = catalogModel?.subProvider?.trim();
  const modelLabel = qualifier
    ? reportedLabel
        .replace(
          new RegExp(
            `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
            "iu",
          ),
          "",
        )
        .trim() || reportedLabel
    : reportedLabel;
  const parentWorkspace = input.parentThread?.worktreePath ?? input.parentProject?.workspaceRoot;
  const childWorkspace = input.childThread?.worktreePath ?? input.childProject?.workspaceRoot;
  const workspace = [
    ...(input.parentThread &&
    input.childProject &&
    input.childProject.id !== input.parentThread.projectId
      ? [{ label: "Project", value: input.childProject.title }]
      : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace
      ? [
          {
            label: input.childThread?.branch
              ? "Branch"
              : input.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: input.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  return { modelLabel, workspace };
}

/** Live work leads with progress; settled work leads with its result. */
export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const result = input.result?.trim();
  const progress = input.progress?.trim();
  const detail =
    (isTerminalSubagentStatus(input.status) ? result || progress : progress || result) || "";
  const compact = detail.replace(/\s+/gu, " ");
  return compact.length > 280 ? `${compact.slice(0, 280).trimEnd()}…` : compact || null;
}

export interface SubagentWorkflowGroup {
  readonly index: number | null;
  readonly title: string;
  readonly agents: ReadonlyArray<OrchestrationV2WorkflowAgent>;
}

/** Keep declared phases, including queued phases, and members whose phase arrived later. */
export function groupSubagentWorkflowAgents(
  workflow: OrchestrationV2SubagentWorkflow,
): ReadonlyArray<SubagentWorkflowGroup> {
  const groups = new Map<
    number | null,
    { title: string; agents: OrchestrationV2WorkflowAgent[] }
  >();
  for (const phase of workflow.phases) {
    groups.set(phase.index, { title: phase.title, agents: [] });
  }
  for (const agent of workflow.agents) {
    const index = agent.phaseIndex ?? null;
    let group = groups.get(index);
    if (group === undefined) {
      group = {
        title: agent.phaseTitle ?? (index === null ? "Agents" : `Phase ${index + 1}`),
        agents: [],
      };
      groups.set(index, group);
    }
    group.agents.push(agent);
  }
  return [...groups].map(([index, group]) => ({ index, ...group }));
}

export function workflowAgentStatusLabel(state: OrchestrationV2WorkflowAgent["state"]): string {
  return state[0]!.toUpperCase() + state.slice(1);
}

/** Queued and running remain distinct, so an unlaunched phase does not claim to be working. */
export function summarizeWorkflowAgentStates(
  agents: ReadonlyArray<OrchestrationV2WorkflowAgent>,
): string {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 };
  for (const agent of agents) counts[agent.state] += 1;
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`)
    .join(" · ");
}

/** Only reported member metadata is shown; missing model and usage stay absent. */
export function workflowAgentMetadata(
  agent: OrchestrationV2WorkflowAgent,
  provider?: Pick<ServerProvider, "driver" | "models">,
): ReadonlyArray<string> {
  return [
    ...(agent.model ? [resolveSubagentMetadata({ model: agent.model, provider }).modelLabel] : []),
    ...(agent.attempt !== undefined && agent.attempt > 1 ? [`Attempt ${agent.attempt}`] : []),
    ...(agent.totalTokens !== undefined ? [`${formatTokens(agent.totalTokens)} tokens`] : []),
    ...(agent.toolCalls !== undefined
      ? [`${agent.toolCalls} ${agent.toolCalls === 1 ? "tool call" : "tool calls"}`]
      : []),
    ...(agent.durationMs !== undefined && agent.durationMs > 0
      ? [formatDuration(agent.durationMs)]
      : []),
  ];
}
