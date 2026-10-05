import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2SubagentWorkflow,
  WORKFLOW_MAX_AGENTS,
  WORKFLOW_MAX_PHASES,
} from "@supacode/contracts";
import { mergeClaudeWorkflowProgress } from "./claudeWorkflowProgress.ts";
import { settleSubagentWorkflow } from "../subagentWorkflow.ts";

const decodeWorkflow = Schema.decodeUnknownSync(OrchestrationV2SubagentWorkflow);

const agent = (overrides: Record<string, unknown> = {}) => ({
  type: "workflow_agent",
  index: 1,
  label: "Check requirements",
  agentId: "a4073ffb714011049",
  phaseIndex: 1,
  phaseTitle: "Apply",
  model: "claude-opus-5-5[1m]",
  state: "progress",
  attempt: 1,
  lastToolName: "Bash",
  tokens: 100021,
  toolCalls: 11,
  ...overrides,
});

describe("Claude workflow progress", () => {
  it("retains authentic phase and member telemetry, excluding prompts and scripts", () => {
    const launched = mergeClaudeWorkflowProgress(undefined, {
      task_type: "local_workflow",
      workflow_name: "Apply documentation",
      prompt: "export const meta = {}",
    });
    const workflow = mergeClaudeWorkflowProgress(launched, {
      workflow_progress: [
        { type: "workflow_phase", index: 2, title: "Rollout" },
        { type: "workflow_phase", index: 1, title: "Apply" },
        agent({ promptPreview: "private member prompt", resultPreview: "large result" }),
      ],
    });
    expect(workflow).toEqual({
      name: "Apply documentation",
      phases: [
        { index: 1, title: "Apply" },
        { index: 2, title: "Rollout" },
      ],
      agents: [
        {
          index: 1,
          label: "Check requirements",
          agentId: "a4073ffb714011049",
          phaseIndex: 1,
          phaseTitle: "Apply",
          model: "claude-opus-5-5[1m]",
          state: "running",
          attempt: 1,
          lastToolName: "Bash",
          totalTokens: 100021,
          toolCalls: 11,
        },
      ],
    });
    expect(decodeWorkflow(workflow)).toEqual(workflow);
    expect(mergeClaudeWorkflowProgress(workflow, { workflow_progress: [] })).toEqual(workflow);
    expect(mergeClaudeWorkflowProgress(undefined, { task_type: "local_agent" })).toBeUndefined();
  });

  it("preserves settled attempts and clears stale attempt metadata when a member retries", () => {
    const completed = mergeClaudeWorkflowProgress(undefined, {
      workflow_progress: [agent({ state: "done" })],
    });
    const late = mergeClaudeWorkflowProgress(completed, {
      workflow_progress: [agent({ state: "queued", tokens: 2 })],
    });
    expect(late).toEqual(completed);
    const retry = mergeClaudeWorkflowProgress(late, {
      workflow_progress: [
        agent({
          state: "start",
          attempt: 2,
          agentId: "retry-agent",
          model: undefined,
          lastToolName: undefined,
          tokens: undefined,
          toolCalls: undefined,
        }),
      ],
    });
    expect(retry?.agents[0]).toEqual({
      index: 1,
      label: "Check requirements",
      state: "running",
      agentId: "retry-agent",
      phaseIndex: 1,
      phaseTitle: "Apply",
      attempt: 2,
    });
    expect(
      mergeClaudeWorkflowProgress(retry, {
        workflow_progress: [agent({ state: "done", attempt: 1 })],
      }),
    ).toEqual(retry);
  });

  it("bounds roster size and skips invalid entries without dropping valid members", () => {
    const workflow = mergeClaudeWorkflowProgress(undefined, {
      workflow_progress: [
        null,
        {},
        agent({ index: -1 }),
        agent({ index: 1.5 }),
        agent({ state: "unknown" }),
        agent({ label: "x".repeat(513) }),
        agent({ index: 3, tokens: Infinity, toolCalls: -1 }),
        ...Array.from({ length: WORKFLOW_MAX_PHASES + 10 }, (_, index) => ({
          type: "workflow_phase",
          index,
          title: `Phase ${index}`,
        })),
        ...Array.from({ length: WORKFLOW_MAX_AGENTS + 10 }, (_, index) => agent({ index })),
      ],
    });
    expect(workflow?.phases).toHaveLength(WORKFLOW_MAX_PHASES);
    expect(workflow?.agents).toHaveLength(WORKFLOW_MAX_AGENTS);
    expect(workflow?.truncated).toBe(true);
    expect(decodeWorkflow(workflow)).toEqual(workflow);
    const numeric = mergeClaudeWorkflowProgress(undefined, {
      workflow_progress: [agent({ tokens: Infinity, toolCalls: -1 })],
    });
    expect(numeric?.agents[0]?.totalTokens).toBeUndefined();
    expect(numeric?.agents[0]?.toolCalls).toBeUndefined();
  });

  it.each(["cancelled", "interrupted", "failed", "completed"] as const)(
    "settles unfinished members when the coordinator is %s without overwriting observed outcomes",
    (status) => {
      const workflow = mergeClaudeWorkflowProgress(undefined, {
        workflow_progress: [
          agent({ index: 1, state: "done" }),
          agent({ index: 2, state: "error" }),
          agent({ index: 3, state: "progress" }),
          agent({ index: 4, state: "queued" }),
        ],
      });
      const settled = settleSubagentWorkflow(workflow, status);
      expect(settled?.agents.map(({ state }) => state)).toEqual([
        "completed",
        "failed",
        status === "completed"
          ? "completed"
          : status === "interrupted"
            ? "interrupted"
            : "cancelled",
        status === "interrupted" ? "interrupted" : "cancelled",
      ]);
      expect(settleSubagentWorkflow(settled, status)).toEqual(settled);
    },
  );

  it("replaces inferred completion with a reported failure without changing observed outcomes", () => {
    const running = mergeClaudeWorkflowProgress(undefined, { workflow_progress: [agent()] });
    const inferred = settleSubagentWorkflow(running, "completed");
    expect(inferred?.agents[0]).toMatchObject({ state: "completed", completionInferred: true });
    const lateRunning = mergeClaudeWorkflowProgress(inferred, { workflow_progress: [agent()] });
    expect(lateRunning).toEqual(inferred);
    const failure = mergeClaudeWorkflowProgress(inferred, {
      workflow_progress: [agent({ state: "error" })],
    });
    expect(failure?.agents[0]?.state).toBe("failed");
    expect(failure?.agents[0]?.completionInferred).toBeUndefined();
    const success = mergeClaudeWorkflowProgress(inferred, {
      workflow_progress: [agent({ state: "done" })],
    });
    expect(success?.agents[0]?.state).toBe("completed");
    expect(success?.agents[0]?.completionInferred).toBeUndefined();
    expect(
      mergeClaudeWorkflowProgress(success, { workflow_progress: [agent({ state: "error" })] }),
    ).toEqual(success);
  });

  it("allows authentic late completion to enrich a member cancelled by process loss", () => {
    const running = mergeClaudeWorkflowProgress(undefined, { workflow_progress: [agent()] });
    const cancelled = settleSubagentWorkflow(running, "cancelled");
    const late = mergeClaudeWorkflowProgress(cancelled, {
      workflow_progress: [agent({ state: "done", tokens: 120000 })],
    });
    expect(late?.agents[0]?.state).toBe("completed");
    expect(late?.agents[0]?.totalTokens).toBe(120000);
  });
});
