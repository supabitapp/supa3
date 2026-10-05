import {
  groupSubagentWorkflowAgents,
  summarizeWorkflowAgentStates,
  workflowAgentMetadata,
  workflowAgentStatusLabel,
  type SubagentWorkflowGroup,
} from "@supacode/client-runtime/state/subagent-display";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  ServerProvider,
} from "@supacode/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

/** The provider coordinator owns this roster; members have no Supacode thread to open. */
export function WorkflowRoster(props: {
  readonly workflow: OrchestrationV2SubagentWorkflow;
  readonly status: OrchestrationV2Subagent["status"];
  readonly provider?: ServerProvider | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const { workflow } = props;
  const summary = summarizeWorkflowAgentStates(workflow.agents);
  const title = workflow.name ? `Workflow · ${workflow.name}` : "Workflow";
  const count = `${workflow.agents.length} ${workflow.agents.length === 1 ? "agent" : "agents"}`;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-workflow-roster>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <Chevron aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{title}</span>
          <span className="block text-2xs text-muted-foreground">
            {count}
            {summary ? ` · ${summary}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {threadRelationshipStatusLabel(props.status)}
        </span>
      </button>
      {expanded ? (
        <div className="max-h-72 overflow-y-auto overscroll-contain pl-3">
          {groupSubagentWorkflowAgents(workflow).map((group) => (
            <WorkflowPhase
              key={group.index ?? "unassigned"}
              group={group}
              provider={props.provider}
            />
          ))}
          {workflow.agents.length === 0 ? (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">No members reported yet.</p>
          ) : null}
          {workflow.truncated ? (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">
              This workflow is larger than the retained roster. Additional members may be omitted.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowPhase(props: {
  readonly group: SubagentWorkflowGroup;
  readonly provider: ServerProvider | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const summary = summarizeWorkflowAgentStates(props.group.agents);
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-md px-2 py-1.5 text-left text-2xs hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <Chevron aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground/85">{props.group.title}</span>
          <span className="block text-muted-foreground">
            {summary || "No members reported yet"}
          </span>
        </span>
      </button>
      {expanded ? (
        <ul className="m-0 list-none space-y-2 border-l border-border/65 py-1 pl-4 pr-2">
          {props.group.agents.map((agent) => (
            <li key={agent.index}>
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 break-words text-2xs font-medium text-foreground/85">
                  {agent.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-2xs",
                    agent.state === "failed"
                      ? "text-destructive"
                      : agent.state === "running"
                        ? "text-info"
                        : agent.state === "completed"
                          ? "text-success"
                          : "text-muted-foreground",
                  )}
                >
                  {workflowAgentStatusLabel(agent.state)}
                </span>
              </div>
              <p className="m-0 text-2xs text-muted-foreground">
                {workflowAgentMetadata(agent, props.provider).join(" · ")}
              </p>
              {agent.lastToolName ? (
                <p className="m-0 break-words text-2xs text-muted-foreground">
                  Last tool: {agent.lastToolName}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
