import type { OrchestrationV2SubagentWorkflow } from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { projectedSubagentsToRuntime } from "./subagentRuntime.ts";

const coordinator = {
  id: "workflow-1",
  title: "CCWorkflows",
  prompt: "Run the review workflow",
  model: null,
  status: "running" as const,
  result: null,
  startedAt: DateTime.makeUnsafe("2026-10-05T12:00:00Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-05T12:00:02Z"),
};

describe("projectedSubagentsToRuntime", () => {
  it("retains the provider roster on one workflow coordinator without creating member entities", () => {
    const workflow: OrchestrationV2SubagentWorkflow = {
      name: "Review and verify",
      phases: [
        { index: 0, title: "Review" },
        { index: 1, title: "Verify" },
      ],
      agents: [
        { index: 0, label: "Correctness", state: "completed", phaseIndex: 0 },
        { index: 1, label: "Security", state: "running", phaseIndex: 0 },
        { index: 2, label: "Verifier", state: "queued", phaseIndex: 1 },
      ],
      truncated: true,
    };
    const agents = projectedSubagentsToRuntime([{ ...coordinator, workflow }]);

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "workflow-1",
      kind: "workflow",
      workflowName: "Review and verify",
      phases: workflow.phases,
      workflow,
      parentAgentId: null,
    });
  });

  it("leaves ordinary provider and app-owned subagent presentation unchanged", () => {
    const agent = projectedSubagentsToRuntime([coordinator])[0]!;
    expect(agent.kind).toBe("subagent");
    expect(agent.workflow).toBeUndefined();
    expect(agent.workflowName).toBeNull();
    expect(agent.phases).toEqual([]);
    expect(agent.title).toBe("CCWorkflows");
  });
});
