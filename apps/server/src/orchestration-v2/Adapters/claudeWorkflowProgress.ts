import {
  NonNegativeInt,
  WORKFLOW_MAX_AGENTS,
  WORKFLOW_MAX_PHASES,
  TrimmedNonEmptyString,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  type OrchestrationV2WorkflowPhase,
} from "@supacode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Workflow progress is absent from the SDK's types. Decode entries separately
// so a malformed or newer entry does not discard the rest of the roster.
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeText = Schema.decodeUnknownOption(TrimmedNonEmptyString.check(Schema.isMaxLength(512)));
const decodeCount = Schema.decodeUnknownOption(
  NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  Option.getOrElse(decodeRecord(value), () => ({}));
const text = (value: unknown) => Option.getOrUndefined(decodeText(value));
const count = (value: unknown) => Option.getOrUndefined(decodeCount(value));
const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

const states: Readonly<Record<string, OrchestrationV2WorkflowAgent["state"]>> = {
  queued: "queued",
  start: "running",
  progress: "running",
  done: "completed",
  error: "failed",
};

function parseAgent(
  entry: Readonly<Record<string, unknown>>,
): OrchestrationV2WorkflowAgent | undefined {
  const index = count(entry.index);
  const label = text(entry.label);
  const state = states[text(entry.state) ?? ""];
  if (index === undefined || label === undefined || state === undefined) return undefined;
  return {
    index,
    label,
    state,
    ...optional("agentId", text(entry.agentId)),
    ...optional("phaseIndex", count(entry.phaseIndex)),
    ...optional("phaseTitle", text(entry.phaseTitle)),
    ...optional("model", text(entry.model)),
    ...optional("lastToolName", text(entry.lastToolName)),
    ...optional("attempt", count(entry.attempt)),
    ...optional("totalTokens", count(entry.tokens)),
    ...optional("toolCalls", count(entry.toolCalls)),
    ...optional("durationMs", count(entry.durationMs)),
  };
}

/** Merge partial snapshots without allowing a stale attempt to reopen a settled member. */
export function mergeClaudeWorkflowProgress(
  previous: OrchestrationV2SubagentWorkflow | undefined,
  value: unknown,
): OrchestrationV2SubagentWorkflow | undefined {
  const message = record(value);
  const phases = new Map<number, OrchestrationV2WorkflowPhase>(
    previous?.phases.map((phase) => [phase.index, phase]),
  );
  const agents = new Map<number, OrchestrationV2WorkflowAgent>(
    previous?.agents.map((agent) => [agent.index, agent]),
  );
  let truncated = previous?.truncated ?? false;
  if (Array.isArray(message.workflow_progress)) {
    // The retained roster is bounded, and pathological frames also have a scan bound.
    if (message.workflow_progress.length > 2_048) truncated = true;
    for (const value of message.workflow_progress.slice(0, 2_048)) {
      const entry = record(value);
      if (entry.type === "workflow_phase") {
        const index = count(entry.index);
        const title = text(entry.title);
        if (index === undefined || title === undefined) continue;
        if (phases.has(index) || phases.size < WORKFLOW_MAX_PHASES)
          phases.set(index, { index, title });
        else truncated = true;
      } else if (entry.type === "workflow_agent") {
        const agent = parseAgent(entry);
        if (agent === undefined) continue;
        const prior = agents.get(agent.index);
        if (prior === undefined && agents.size >= WORKFLOW_MAX_AGENTS) {
          truncated = true;
          continue;
        }
        const attempt = agent.attempt ?? prior?.attempt ?? 1;
        if (prior !== undefined && attempt < (prior.attempt ?? 1)) continue;
        const restarted = prior !== undefined && attempt > (prior.attempt ?? 1);
        const reportedOutcome = agent.state === "completed" || agent.state === "failed";
        const regressed =
          !restarted &&
          prior !== undefined &&
          (((prior.state === "completed" || prior.state === "failed") &&
            agent.state !== prior.state &&
            !(prior.completionInferred === true && reportedOutcome)) ||
            ((prior.state === "cancelled" || prior.state === "interrupted") &&
              (agent.state === "queued" || agent.state === "running")) ||
            (prior.state === "running" && agent.state === "queued"));
        const retained =
          prior === undefined || !reportedOutcome
            ? prior
            : (({ completionInferred: _inferred, ...observed }) => observed)(prior);
        agents.set(
          agent.index,
          regressed
            ? { ...agent, ...prior }
            : {
                ...(restarted
                  ? {
                      ...optional("phaseIndex", prior.phaseIndex),
                      ...optional("phaseTitle", prior.phaseTitle),
                    }
                  : retained),
                ...agent,
              },
        );
      }
    }
  }
  if (
    previous === undefined &&
    message.task_type !== "local_workflow" &&
    phases.size === 0 &&
    agents.size === 0
  )
    return undefined;
  return {
    ...optional("name", text(message.workflow_name) ?? previous?.name),
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    ...(truncated ? { truncated: true } : {}),
  };
}
