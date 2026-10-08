import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@supacode/contracts";

import type { ThreadCreation } from "./threadCreationStorage";

export function creation(id = "draft"): ThreadCreation {
  return {
    id,
    revision: 0,
    status: "waiting",
    routingKey: "repository::app",
    logicalProjectKey: "repository",
    sourceEnvironmentId: EnvironmentId.make("source"),
    sourceProjectId: ProjectId.make("source-project"),
    driver: ProviderDriverKind.make("codex"),
    prompt: "Saved prompt",
    payload: {
      draftId: id,
      environmentId: EnvironmentId.make("source"),
      localAttachments: [],
      input: {
        commandId: CommandId.make(`command:${id}`),
        threadId: ThreadId.make(`thread:${id}`),
        message: {
          messageId: MessageId.make(`message:${id}`),
          role: "user",
          text: "Saved prompt",
          attachments: [],
        },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("source-project"),
            title: "Saved prompt",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-10-08T00:00:00Z",
          },
        },
      },
    },
  };
}
