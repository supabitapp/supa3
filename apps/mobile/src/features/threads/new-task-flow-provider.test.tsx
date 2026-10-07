import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@supacode/client-runtime/state/shell";
import {
  AuthFilesystemReadScope,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@supacode/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import type { QueuedThreadMessage } from "../../state/thread-outbox";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";

const transport = vi.hoisted(() => ({ openScratch: vi.fn(), openScratchCommand: Symbol() }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../state/entities", () => ({
  useProjects: () => useAtomValue(projectsAtom),
  useThreadShells: () => [],
  useEnvironmentServerConfig: (id: EnvironmentId | null) => configs.get(id!) ?? null,
  useServerConfigs: () => configs,
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { openScratch: transport.openScratchCommand, readFile: () => null },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => transport.openScratch,
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => sessionAtom },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === sessionAtom ? { authenticated: true, scopes: [AuthFilesystemReadScope] } : null,
    error: null,
    isPending: false,
  }),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../state/queries", () => ({
  useDebouncedValue: (value: string) => value,
  usePaginatedBranches: () => ({
    refs: [],
    data: null,
    isPending: false,
    isFetchingNextPage: false,
    refresh: () => {},
    loadNext: () => {},
  }),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "separate" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: Object.fromEntries(
      environmentIds.map((id) => [id, { environmentLabel: id }]),
    ),
  }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: environmentIds.map((id) => ({
      environmentId: id,
      environmentLabel: id,
      connectionState: "connected",
    })),
  }),
  setPendingConnectionError: () => {},
}));
vi.mock("../../state/use-model-option-memory", () => ({
  rememberModelOptions: () => {},
  withRememberedModelOptions: (selection: unknown) => selection,
}));
vi.mock("../../state/pending-task-editor-writes", () => ({
  capturePendingTaskEditorWriteBaseline: () => Promise.resolve(0),
  flushPendingTaskEditorWrite: () => Promise.resolve(true),
}));
vi.mock("../../state/thread-outbox", () => ({
  get threadOutboxManager() {
    return { queuedMessagesByThreadKeyAtom: queueAtom };
  },
  flattenQueuedThreadMessages: (messages: Record<string, ReadonlyArray<QueuedThreadMessage>>) =>
    Object.values(messages).flat(),
}));
vi.mock("../../state/use-thread-outbox", () => ({
  useThreadOutboxMessages: () => useAtomValue(queueAtom),
  holdEditingQueuedMessage: () => true,
  releaseEditingQueuedMessage: () => {},
}));
// The provider uses the real atom registry with an in-memory draft store; native
// persistence and attachment cleanup are outside environment-switch behavior.
vi.mock("../../state/use-composer-drafts", () => ({
  get composerDraftsAtom() {
    return draftsAtom;
  },
  useComposerDraft: (key: string | null) => useAtomValue(draftsAtom)[key ?? ""] ?? emptyDraft,
  getComposerDraftSnapshot: (key: string) => readDraft(key),
  createNewTaskDraft: (project: { environmentId: EnvironmentId; projectId: ProjectId }) =>
    createDraft(project),
  retargetNewTaskDraft: (
    key: string,
    project: { environmentId: EnvironmentId; projectId: ProjectId },
  ) => updateDraft(key, { project: { ...project, createdAt: timestamp } }),
  isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
  isComposerDraftEmpty: (draft: ComposerDraft) =>
    draft.text === "" && draft.attachments.length === 0,
  setComposerDraftText: (key: string, text: string) => updateDraft(key, { text }),
  setComposerDraftContext: (key: string, context: ComposerDraft["context"]) =>
    updateDraft(key, { context }),
  replaceComposerDraftAttachments: (key: string, attachments: ComposerDraft["attachments"]) =>
    updateDraft(key, { attachments }),
  updateComposerDraftSettings: (key: string, settings: Partial<ComposerDraft>) =>
    updateDraft(key, settings),
  useStickyComposerModelSelection: () => null,
  setStickyComposerModelSelection: () => {},
  setStickyNewTaskProject: () => {},
  scheduleUnusedComposerAttachmentCleanup: () => {},
  clearComposerDraft: (key: string) => {
    const drafts = { ...appAtomRegistry.get(draftsAtom) };
    delete drafts[key];
    appAtomRegistry.set(draftsAtom, drafts);
  },
}));

const timestamp = "2026-10-04T00:00:00.000Z";
const environmentIds = ["first", "second", "third"].map((id) => EnvironmentId.make(id));
const [firstEnvironment, secondEnvironment, thirdEnvironment] = environmentIds;
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: timestamp,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const configs = new Map(
  environmentIds.map((id) => [
    id,
    {
      providers: [provider],
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      scratchWorkspaceRoot: `/scratch/${id}`,
    },
  ]),
);
function project(environmentId: EnvironmentId, scratch = true): EnvironmentProject {
  return {
    id: ProjectId.make(`${environmentId}-${scratch ? "scratch" : "repo"}`),
    environmentId,
    title: scratch ? "Scratch" : "Repository",
    workspaceRoot: scratch ? `/scratch/${environmentId}` : `/repo/${environmentId}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
const firstProject = project(firstEnvironment!);
const secondProject = project(secondEnvironment!);
const thirdProject = project(thirdEnvironment!);
const repositoryProject = project(firstEnvironment!, false);
const sessionAtom = Atom.make(AsyncResult.initial());
const projectsAtom = Atom.make<ReadonlyArray<EnvironmentProject>>([]).pipe(Atom.keepAlive);
const draftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(Atom.keepAlive);
const queueAtom = Atom.make<Record<string, ReadonlyArray<QueuedThreadMessage>>>({}).pipe(
  Atom.keepAlive,
);
const emptyDraft: ComposerDraft = { text: "", attachments: [] };
let nextDraft = 0;
function readDraft(key: string) {
  return appAtomRegistry.get(draftsAtom)[key] ?? emptyDraft;
}
function updateDraft(key: string, patch: Partial<ComposerDraft>) {
  appAtomRegistry.set(draftsAtom, {
    ...appAtomRegistry.get(draftsAtom),
    [key]: { ...readDraft(key), ...patch },
  });
}
function createDraft(projectRef: { environmentId: EnvironmentId; projectId: ProjectId }) {
  const key = `new-task:${++nextDraft}`;
  updateDraft(key, { project: { ...projectRef, createdAt: timestamp } });
  return key;
}
const metadata = {
  threadId: "new-thread",
  commandId: "send",
  messageId: "new-message",
  createdAt: timestamp,
};
const pendingTask: QueuedThreadMessage = {
  environmentId: firstEnvironment!,
  threadId: ThreadId.make("queued-thread"),
  messageId: MessageId.make("queued-message"),
  commandId: CommandId.make("queued-command"),
  text: "Queued task",
  attachments: [],
  modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
  createdAt: timestamp,
  creation: {
    projectId: repositoryProject.id,
    workspaceMode: "local",
    branch: null,
    worktreePath: null,
  },
};

let renderer: ReactTestRenderer | null = null;
let flow: ReturnType<typeof useNewTaskFlow>;
function Probe() {
  const current = useNewTaskFlow();
  useLayoutEffect(() => {
    flow = current;
  }, [current]);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  transport.openScratch.mockReset();
  nextDraft = 0;
  appAtomRegistry.set(projectsAtom, [firstProject, secondProject, thirdProject, repositoryProject]);
  appAtomRegistry.set(draftsAtom, {});
  appAtomRegistry.set(queueAtom, {});
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={appAtomRegistry}>
        <NewTaskFlowProvider>
          <Probe />
        </NewTaskFlowProvider>
      </RegistryContext.Provider>,
    );
  });
  await act(() => flow.setPrompt("Work in the selected environment"));
});
afterEach(async () => {
  await act(() => {
    if (renderer) {
      flow.finishEditingPendingTask();
      renderer.unmount();
    }
  });
  renderer = null;
  vi.unstubAllGlobals();
});

function beginSwitch(environmentId = secondEnvironment!) {
  const completion = Promise.withResolvers<AsyncResult.Success<EnvironmentProject>>();
  transport.openScratch.mockImplementationOnce(() => completion.promise);
  const switched = flow.switchEnvironment(environmentId);
  return {
    switched,
    complete: (destination = secondProject) => completion.resolve(AsyncResult.success(destination)),
  };
}

describe("new-task environment switching", () => {
  it("blocks an immediate submission before the pending switch rerenders", async () => {
    let pending!: ReturnType<typeof beginSwitch>;
    await act(() => {
      pending = beginSwitch();
      expect(flow.buildPendingTaskMessage(metadata)).toBeNull();
    });
    expect(flow.switchingToEnvironmentId).toBe(secondEnvironment);
    await act(async () => {
      pending.complete();
      expect(await pending.switched).toBe(true);
    });
    expect(flow.buildPendingTaskMessage(metadata)?.environmentId).toBe(secondEnvironment);
    expect(readDraft(flow.draftKey!).text).toBe("Work in the selected environment");
  });

  it.each(["reset", "project", "draft", "pending-task", "submission"] as const)(
    "does not retarget after %s replaces the pending switch",
    async (action) => {
      const originalDraft = flow.draftKey!;
      let pending!: ReturnType<typeof beginSwitch>;
      await act(() => {
        pending = beginSwitch();
      });
      await act(() => {
        switch (action) {
          case "reset":
            flow.reset();
            break;
          case "project":
            flow.setProject(repositoryProject);
            break;
          case "draft": {
            const other = createDraft({
              environmentId: firstEnvironment!,
              projectId: repositoryProject.id,
            });
            updateDraft(other, { text: "Other draft" });
            expect(flow.openDraft(other)).toBe(true);
            break;
          }
          case "pending-task":
            appAtomRegistry.set(queueAtom, { queued: [pendingTask] });
            expect(flow.beginEditingPendingTask(pendingTask.messageId)).toBe(true);
            break;
          case "submission":
            flow.setSubmitting(true);
            break;
        }
      });
      const selectedProject = flow.selectedProject;
      const selectedDraft = flow.draftKey;
      await act(async () => {
        pending.complete();
        expect(await pending.switched).toBe(false);
      });
      expect(flow.selectedProject).toBe(selectedProject);
      expect(flow.draftKey).toBe(selectedDraft);
      expect(readDraft(originalDraft).project?.environmentId).toBe(firstEnvironment);
      expect(flow.switchingToEnvironmentId).toBeNull();
    },
  );

  it("does not retarget an unmounted flow's saved draft", async () => {
    const originalDraft = flow.draftKey!;
    let pending!: ReturnType<typeof beginSwitch>;
    await act(() => {
      pending = beginSwitch();
    });
    await act(() => {
      renderer?.unmount();
      renderer = null;
    });
    pending.complete();
    expect(await pending.switched).toBe(false);
    expect(readDraft(originalDraft).project?.environmentId).toBe(firstEnvironment);
  });

  it("keeps the latest cycle when Scratch lookups finish out of order", async () => {
    let second!: ReturnType<typeof beginSwitch>;
    let third!: ReturnType<typeof beginSwitch>;
    await act(() => {
      second = beginSwitch();
    });
    await act(() => {
      third = beginSwitch(thirdEnvironment!);
    });
    expect(flow.switchingToEnvironmentId).toBe(thirdEnvironment);
    await act(async () => {
      third.complete(thirdProject);
      expect(await third.switched).toBe(true);
    });
    await act(async () => {
      second.complete();
      expect(await second.switched).toBe(false);
    });
    expect(flow.buildPendingTaskMessage(metadata)?.environmentId).toBe(thirdEnvironment);
    expect(readDraft(flow.draftKey!).project?.projectId).toBe(thirdProject.id);
  });

  it("keeps submission blocked when an older lookup finishes first", async () => {
    let second!: ReturnType<typeof beginSwitch>;
    let third!: ReturnType<typeof beginSwitch>;
    await act(() => {
      second = beginSwitch();
    });
    await act(() => {
      third = beginSwitch(thirdEnvironment!);
    });
    await act(async () => {
      second.complete();
      expect(await second.switched).toBe(false);
    });
    expect(flow.switchingToEnvironmentId).toBe(thirdEnvironment);
    expect(flow.buildPendingTaskMessage(metadata)).toBeNull();
    await act(async () => {
      third.complete(thirdProject);
      expect(await third.switched).toBe(true);
    });
    expect(flow.buildPendingTaskMessage(metadata)?.environmentId).toBe(thirdEnvironment);
  });

  it("rejects environment switching while submitting", async () => {
    await act(async () => {
      flow.setSubmitting(true);
      expect(await flow.switchEnvironment(secondEnvironment!)).toBe(false);
    });
    expect(flow.selectedProject).toBe(firstProject);
    expect(transport.openScratch).not.toHaveBeenCalled();
  });

  it("invalidates a switch when catalog changes replace the selected project", async () => {
    const originalDraft = flow.draftKey!;
    let pending!: ReturnType<typeof beginSwitch>;
    await act(() => {
      pending = beginSwitch();
    });
    await act(() =>
      appAtomRegistry.set(projectsAtom, [repositoryProject, secondProject, thirdProject]),
    );
    expect(flow.selectedProject).toBe(repositoryProject);
    await act(async () => {
      pending.complete();
      expect(await pending.switched).toBe(false);
    });
    expect(flow.selectedProject).toBe(repositoryProject);
    expect(readDraft(originalDraft).project?.environmentId).toBe(firstEnvironment);
  });
});
