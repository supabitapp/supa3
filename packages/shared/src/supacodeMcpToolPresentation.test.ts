import { describe, expect, it } from "vite-plus/test";

import {
  SUPACODE_MCP_TOOL_NAMES,
  resolveSupacodeMcpToolPresentation,
} from "./supacodeMcpToolPresentation.ts";

describe("resolveSupacodeMcpToolPresentation", () => {
  it("recognizes every tool across provider prefixes and completion suffixes", () => {
    for (const tool of SUPACODE_MCP_TOOL_NAMES) {
      const presentation = resolveSupacodeMcpToolPresentation(tool);
      expect(presentation, tool).not.toBeNull();
      for (const prefix of [
        "mcp__supacode__",
        "mcp__Supacode__",
        "supacode.",
        "Supacode.",
        "supacode/",
        "supacode:",
        "mcp_supacode_",
        "supacode ",
        "Supacode ",
        "supacode · ",
      ]) {
        expect(resolveSupacodeMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveSupacodeMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Supacode MCP tool names", () => {
    expect(resolveSupacodeMcpToolPresentation("mcp__supacode__supacode_thread_read")).toEqual({
      displayName: "Read a Supacode thread",
      logo: "supacode",
    });
  });

  it("pretty prints Codex Supacode MCP tool names", () => {
    expect(resolveSupacodeMcpToolPresentation("supacode.create_threads")).toEqual({
      displayName: "Create Supacode threads",
      logo: "supacode",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveSupacodeMcpToolPresentation("mcp__supacode__supacode_thread_update")).toEqual({
      displayName: "Update Supacode thread metadata",
      logo: "supacode",
    });
  });

  it("pretty prints bare Supacode MCP toolkit names", () => {
    expect(resolveSupacodeMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "supacode",
    });
  });

  it("pretty prints worktree Supacode MCP tool names", () => {
    expect(resolveSupacodeMcpToolPresentation("mcp__supacode__supacode_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "supacode",
    });
    expect(resolveSupacodeMcpToolPresentation("supacode.supacode_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "supacode",
    });
  });

  it("pretty prints preview Supacode MCP tool names", () => {
    expect(resolveSupacodeMcpToolPresentation("Supacode.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "supacode",
    });
    expect(resolveSupacodeMcpToolPresentation("mcp__supacode__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "supacode",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_supacode_delegate_task",
      "supacode:delegate_task",
      "supacode/delegate_task",
      "supacode delegate_task",
      "supacode__delegate_task",
    ]) {
      expect(resolveSupacodeMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveSupacodeMcpToolPresentation("supacode-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveSupacodeMcpToolPresentation("supacode-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveSupacodeMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveSupacodeMcpToolPresentation("supacode.not_a_real_tool")).toBeNull();
  });
});
