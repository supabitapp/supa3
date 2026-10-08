import {
  deriveLogicalProjectKey,
  derivePhysicalProjectKey,
  deriveRepositoryRelativeProjectPath,
} from "@supacode/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@supacode/client-runtime/state/shell";
import type { ServerConfig } from "@supacode/contracts";

import type { ThreadCreation } from "./threadCreationStorage";
import type { ThreadCreationBinding } from "./threadCreationStorage";
import type { DraftSessionState } from "../composerDraftStore";
import { scopeThreadRef } from "@supacode/client-runtime/environment";

export function resolveThreadCreationBindingRef(
  binding: ThreadCreationBinding | null | undefined,
  draft: Pick<DraftSessionState, "queuedForMachine"> | null,
) {
  if (!binding || (draft !== null && !draft.queuedForMachine)) return null;
  return scopeThreadRef(binding.environmentId, binding.threadId);
}

type CreationProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

export function threadCreationRoutingKey(project: CreationProject) {
  if (deriveRepositoryRelativeProjectPath(project) === null)
    return derivePhysicalProjectKey(project);
  return deriveLogicalProjectKey(project, { groupingMode: "repository_path" });
}

export function threadCreationProvider(
  entry: ThreadCreation,
  config: Pick<ServerConfig, "providers">,
) {
  const selection = entry.payload.input.modelSelection;
  return (
    config.providers.find(
      (provider) =>
        provider.instanceId === selection.instanceId &&
        provider.driver === entry.driver &&
        provider.enabled &&
        provider.installed &&
        provider.status !== "error" &&
        provider.auth.status !== "unauthenticated" &&
        provider.availability !== "unavailable" &&
        (provider.models.length === 0 ||
          provider.models.some(
            (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
          )),
    ) ?? null
  );
}

export function bindThreadCreation(entry: ThreadCreation, project: CreationProject) {
  const { input } = entry.payload;
  const creation = input.bootstrap.createThread;
  const prepareWorktree = input.bootstrap.prepareWorktree;
  return {
    ...entry.payload,
    environmentId: project.environmentId,
    input: {
      ...input,
      bootstrap: {
        ...input.bootstrap,
        createThread: { ...creation, projectId: project.id },
        ...(prepareWorktree
          ? {
              prepareWorktree: { ...prepareWorktree, projectCwd: project.workspaceRoot },
            }
          : {}),
      },
    },
  };
}
