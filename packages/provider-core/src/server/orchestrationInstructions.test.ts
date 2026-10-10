import { assert, describe, it } from "@effect/vitest";

import {
  SUPACODE_ORCHESTRATION_INSTRUCTIONS,
  supacodeAcpPromptWithInstructions,
  supacodeOrchestrationPromptForFirstRun,
  supacodeOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Supacode orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      SUPACODE_ORCHESTRATION_INSTRUCTIONS,
      "ordinary top-level Supacode conversations",
    );
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      SUPACODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `supacode_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(SUPACODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = supacodeOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasSupacodeMcp: true,
    });

    assert.include(injected, "<supacode_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      supacodeOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasSupacodeMcp: true }),
      prompt,
    );
    assert.equal(
      supacodeOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasSupacodeMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Supacode MCP server is attached", () => {
    assert.equal(supacodeOrchestrationSystemPrompt(false), undefined);
    assert.equal(supacodeOrchestrationSystemPrompt(true), SUPACODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = supacodeAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasSupacodeMcp: true },
    });

    assert.include(injected, "Supacode interaction mode: Default");
    assert.include(injected, "Supacode collaborative browser");
    assert.include(injected, "Supacode orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasSupacodeMcp: true } as const;

    assert.equal(
      supacodeAcpPromptWithInstructions({
        prompt,
        state: defaultState,
        previousState: defaultState,
      }),
      prompt,
    );
    assert.include(
      supacodeAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Supacode interaction mode: Plan",
    );
    const withoutMcp = supacodeAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasSupacodeMcp: false },
    });
    assert.include(withoutMcp, "Supacode interaction mode: Default");
    assert.notInclude(withoutMcp, "Supacode collaborative browser");
    assert.notInclude(withoutMcp, "Supacode orchestration");
  });
});
