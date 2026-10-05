import {
  groupSubagentWorkflowAgents,
  summarizeWorkflowAgentStates,
  workflowAgentMetadata,
  workflowAgentStatusLabel,
  type SubagentWorkflowGroup,
} from "@supacode/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  OrchestrationV2SubagentWorkflow,
  ProviderInstanceId,
  ServerProvider,
} from "@supacode/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig } from "../../state/entities";

/** Provider workflow members stay inside their coordinator rather than becoming child threads. */
export function WorkflowRoster(props: {
  readonly workflow: OrchestrationV2SubagentWorkflow;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
}) {
  const [expanded, setExpanded] = useState(false);
  const config = useEnvironmentServerConfig(props.environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === props.providerInstanceId,
  );
  const { workflow } = props;
  const title = workflow.name ? `Workflow · ${workflow.name}` : "Workflow";
  const count = `${workflow.agents.length} ${workflow.agents.length === 1 ? "agent" : "agents"}`;
  const summary = summarizeWorkflowAgentStates(workflow.agents);
  return (
    <View className="mt-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${count}${summary ? `, ${summary}` : ""}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 flex-row items-center gap-2 rounded-lg px-2 py-2 active:bg-subtle"
      >
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName="accent-icon-muted"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-supacode-medium text-xs text-foreground">
            {title}
          </Text>
          <Text className="text-2xs text-foreground-muted">
            {count}
            {summary ? ` · ${summary}` : ""}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View className="pl-3">
          {groupSubagentWorkflowAgents(workflow).map((group) => (
            <WorkflowPhase key={group.index ?? "unassigned"} group={group} provider={provider} />
          ))}
          {workflow.agents.length === 0 ? (
            <Text className="px-2 py-2 text-2xs text-foreground-muted">
              No members reported yet.
            </Text>
          ) : null}
          {workflow.truncated ? (
            <Text className="px-2 py-2 text-2xs text-foreground-muted">
              This workflow is larger than the retained roster. Additional members may be omitted.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function WorkflowPhase(props: {
  readonly group: SubagentWorkflowGroup;
  readonly provider: ServerProvider | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const summary = summarizeWorkflowAgentStates(props.group.agents);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.group.title}, ${summary || "No members reported yet"}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 flex-row items-center gap-2 rounded-lg px-2 py-2 active:bg-subtle"
      >
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={10}
          tintColorClassName="accent-icon-muted"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-supacode-medium text-xs text-foreground">{props.group.title}</Text>
          <Text className="text-2xs text-foreground-muted">
            {summary || "No members reported yet"}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View className="ml-2 gap-3 border-l border-border py-2 pl-4">
          {props.group.agents.map((agent) => (
            <View key={agent.index} className="gap-0.5">
              <View className="flex-row items-baseline justify-between gap-2">
                <Text className="min-w-0 flex-1 font-supacode-medium text-xs text-foreground">
                  {agent.label}
                </Text>
                <Text
                  className={cn(
                    "shrink-0 text-2xs",
                    agent.state === "failed"
                      ? "text-adaptive-rose-600-400"
                      : agent.state === "running"
                        ? "text-adaptive-sky-600-400"
                        : agent.state === "completed"
                          ? "text-adaptive-emerald-600-400"
                          : "text-foreground-muted",
                  )}
                >
                  {workflowAgentStatusLabel(agent.state)}
                </Text>
              </View>
              <Text className="text-2xs text-foreground-muted">
                {workflowAgentMetadata(agent, props.provider).join(" · ")}
              </Text>
              {agent.lastToolName ? (
                <Text numberOfLines={1} className="text-2xs text-foreground-muted">
                  Last tool: {agent.lastToolName}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
