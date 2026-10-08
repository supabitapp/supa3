import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ServerProvider } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bindThreadCreation,
  threadCreationProvider,
  threadCreationRoutingKey,
  resolveThreadCreationBindingRef,
} from "./threadCreationRouting";
import { creation } from "./threadCreationTestFixtures";

function project(environmentId: string, rootPath: string, relativePath = "apps/web") {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(`project:${environmentId}`),
    workspaceRoot: `${rootPath}/${relativePath}`,
    repositoryIdentity: {
      canonicalKey: "github.com/supabitapp/supacode-next",
      rootPath,
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/supabitapp/supacode-next.git",
      },
    },
  };
}

const provider = Schema.decodeSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-08T00:00:00Z",
  models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
  slashCommands: [],
});

describe("queued task destination mapping", () => {
  it("follows lost or waiting draft bindings and respects explicitly restored editable drafts", () => {
    const entry = creation();
    const binding = {
      id: entry.id,
      commandId: entry.payload.input.commandId,
      environmentId: EnvironmentId.make("destination"),
      projectId: ProjectId.make("destination-project"),
      threadId: entry.payload.input.threadId,
    };
    expect(resolveThreadCreationBindingRef(binding, null)).toMatchObject({
      environmentId: "destination",
    });
    expect(resolveThreadCreationBindingRef(binding, { queuedForMachine: true })).toMatchObject({
      environmentId: "destination",
    });
    expect(resolveThreadCreationBindingRef(binding, { queuedForMachine: false })).toBeNull();
  });
  it("matches the same relative workspace across machines and excludes other subprojects", () => {
    expect(threadCreationRoutingKey(project("source", "/source/repo"))).toBe(
      threadCreationRoutingKey(project("remote", "/remote/repo")),
    );
    expect(threadCreationRoutingKey(project("source", "/source/repo"))).not.toBe(
      threadCreationRoutingKey(project("remote", "/remote/repo", "apps/server")),
    );
  });
  it("keeps a project with unknown repository layout tied to its own environment", () => {
    const source = { ...project("source", "/source/repo"), repositoryIdentity: null };
    const remote = { ...source, environmentId: EnvironmentId.make("remote") };
    expect(threadCreationRoutingKey(source)).not.toBe(threadCreationRoutingKey(remote));
  });
  it("maps project and worktree paths while retaining execution IDs and settings", () => {
    const entry = creation();
    const queued = {
      ...entry,
      payload: {
        ...entry.payload,
        input: {
          ...entry.payload.input,
          bootstrap: {
            ...entry.payload.input.bootstrap,
            prepareWorktree: { projectCwd: "/source/repo/apps/web", baseBranch: "main" },
          },
        },
      },
    };
    const destination = project("remote", "/remote/repo");
    const bound = bindThreadCreation(queued, destination);
    expect(bound.environmentId).toBe("remote");
    expect(bound.input.bootstrap.createThread.projectId).toBe(destination.id);
    expect(bound.input.bootstrap.prepareWorktree?.projectCwd).toBe(destination.workspaceRoot);
    expect(bound.input.commandId).toBe(entry.payload.input.commandId);
    expect(bound.input.modelSelection).toEqual(entry.payload.input.modelSelection);
    expect(bound.input.message).toEqual(entry.payload.input.message);
  });
  it("requires the chosen provider instance, model and authorization status", () => {
    const entry = creation();
    expect(threadCreationProvider(entry, { providers: [provider] })).toBe(provider);
    expect(
      threadCreationProvider(entry, { providers: [{ ...provider, models: [] }] }),
    ).not.toBeNull();
    expect(
      threadCreationProvider(entry, {
        providers: [{ ...provider, auth: { status: "unauthenticated" } }],
      }),
    ).toBeNull();
    expect(
      threadCreationProvider(entry, {
        providers: [{ ...provider, models: [{ ...provider.models[0]!, slug: "other-model" }] }],
      }),
    ).toBeNull();
  });
});
