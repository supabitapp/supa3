import { inspectLoadBalancedEnvironments } from "@supacode/client-runtime/load-balancing";
import { useEffect, useSyncExternalStore } from "react";
import type { EnvironmentProject } from "@supacode/client-runtime/state/shell";
import { scopeProjectRef, scopeThreadRef } from "@supacode/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderDriverKind,
  type HostResourcesSnapshot,
  type ServerConfig,
} from "@supacode/contracts";

import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
  composerDraftHasUserContent,
  restoreFailedBackgroundDraftThread,
} from "../composerDraftStore";
import { prepareThreadOutboxTurn, webThreadOutbox } from "./threadOutbox";
import {
  threadCreationStorage,
  type ThreadCreation,
  type ThreadCreationBinding,
} from "./threadCreationStorage";
import {
  bindThreadCreation,
  threadCreationProvider,
  threadCreationRoutingKey,
} from "./threadCreationRouting";
import { readProjects } from "./entities";
import { readEnvironmentScope } from "./session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";

let snapshot: ReadonlyArray<ThreadCreation> = [];
let reloadChain = Promise.resolve();
let loaded = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const reasons = new Map<string, string>();
const bindings = new Map<string, ThreadCreationBinding | null>();

function rememberBinding(id: string, binding: ThreadCreationBinding | null) {
  if (bindings.has(id) && JSON.stringify(bindings.get(id)) === JSON.stringify(binding)) return;
  bindings.set(id, binding);
  for (const listener of listeners) listener();
}

export function useThreadCreationBinding(draftId: DraftId | null) {
  useEffect(() => {
    if (draftId === null) return;
    void threadCreationStorage
      .loadBinding(draftId)
      .then((binding) => rememberBinding(draftId, binding))
      .catch(console.error);
  }, [draftId]);
  return useSyncExternalStore(subscribe, () => (draftId === null ? null : bindings.get(draftId)));
}

function recoverBinding(binding: ThreadCreationBinding) {
  const draftId = DraftId.make(binding.id);
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(draftId);
  if (!draft || !draft.queuedForMachine) return;
  if (draft.threadId !== binding.threadId)
    restoreFailedBackgroundDraftThread(draftId, draft, binding.threadId);
  store.setDraftThreadContext(draftId, {
    projectRef: scopeProjectRef(binding.environmentId, binding.projectId),
    environmentSelection: "auto",
    loadBalancedEnvironmentId: binding.environmentId,
    queuedForMachine: false,
  });
  markPromotedDraftThreadByRef(scopeThreadRef(binding.environmentId, binding.threadId));
}

export function setThreadCreationReason(id: string, reason: string) {
  if (reasons.get(id) === reason) return;
  reasons.set(id, reason);
  for (const listener of listeners) listener();
}

export function useThreadCreationReason(id: string) {
  return useSyncExternalStore(subscribe, () => reasons.get(id) ?? "Waiting for a machine");
}

export function reloadThreadCreations() {
  const reload = reloadChain.then(async () => {
    const rows = await threadCreationStorage.load();
    const ids = new Set(rows.map((entry) => entry.id));
    for (const [id, draft] of Object.entries(
      useComposerDraftStore.getState().draftThreadsByThreadKey,
    )) {
      if (!draft.queuedForMachine || ids.has(id)) continue;
      const current = await threadCreationStorage.readState(id);
      const latest = useComposerDraftStore.getState().getDraftSession(DraftId.make(id));
      if (!latest?.queuedForMachine || latest.threadId !== draft.threadId) continue;
      if (current.creation) {
        rows.push(current.creation);
        recoverThreadCreation(current.creation);
      } else if (current.binding) {
        recoverBinding(current.binding);
      } else {
        const store = useComposerDraftStore.getState();
        if (composerDraftHasUserContent(store.getComposerDraft(DraftId.make(id))))
          store.setDraftThreadContext(DraftId.make(id), { queuedForMachine: false });
        else store.clearDraftThread(DraftId.make(id));
      }
      rememberBinding(id, current.binding);
    }
    for (const entry of rows) {
      if (entry.status === "bound")
        rememberBinding(entry.id, await threadCreationStorage.loadBinding(entry.id));
    }
    rows.sort((left, right) =>
      (
        left.payload.input.createdAt ?? left.payload.input.bootstrap.createThread.createdAt
      ).localeCompare(
        right.payload.input.createdAt ?? right.payload.input.bootstrap.createThread.createdAt,
      ),
    );
    if (loaded && JSON.stringify(rows) === JSON.stringify(snapshot)) return;
    loaded = true;
    snapshot = rows;
    for (const listener of listeners) listener();
  });
  reloadChain = reload.catch(() => undefined);
  return reload;
}

export function useThreadCreationsLoaded() {
  return useSyncExternalStore(subscribe, () => loaded);
}

export function useThreadCreations() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export async function enqueueAutomaticThreadCreation(input: {
  target: Parameters<typeof prepareThreadOutboxTurn>[0];
  project: EnvironmentProject;
  logicalProjectKey: string;
  driver: ProviderDriverKind;
  prompt: string;
}) {
  const { payload } = prepareThreadOutboxTurn(input.target);
  if (!payload.draftId || !payload.input.bootstrap?.createThread)
    throw new Error("Automatic queueing requires a new draft.");
  if (
    payload.localAttachments.length > 0 ||
    payload.input.message.context ||
    payload.input.message.attachments.length > 0
  )
    throw new Error("Choose a machine before sending attachments or machine context.");
  await threadCreationStorage.enqueue({
    id: payload.draftId,
    revision: 0,
    status: "waiting",
    routingKey: threadCreationRoutingKey(input.project),
    logicalProjectKey: input.logicalProjectKey,
    sourceEnvironmentId: input.project.environmentId,
    sourceProjectId: input.project.id,
    driver: input.driver,
    prompt: input.prompt,
    payload: {
      ...payload,
      draftId: payload.draftId,
      input: {
        ...payload.input,
        modelSelection:
          payload.input.modelSelection ?? payload.input.bootstrap.createThread.modelSelection,
        bootstrap: {
          ...payload.input.bootstrap,
          createThread: payload.input.bootstrap.createThread,
        },
      },
    },
  });
  await reloadThreadCreations();
  const saved = snapshot.find((entry) => entry.id === payload.draftId);
  if (saved) recoverThreadCreation(saved);
}

export function recoverThreadCreation(entry: ThreadCreation) {
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make(entry.id);
  if (!store.getDraftSession(draftId)) {
    const creation = entry.payload.input.bootstrap.createThread;
    useComposerDraftStore.setState((state) => ({
      draftThreadsByThreadKey: {
        ...state.draftThreadsByThreadKey,
        [draftId]: {
          threadId: entry.payload.input.threadId,
          environmentId: entry.sourceEnvironmentId,
          projectId: entry.sourceProjectId,
          logicalProjectKey: entry.logicalProjectKey,
          createdAt: creation.createdAt,
          runtimeMode: entry.payload.input.runtimeMode,
          interactionMode: entry.payload.input.interactionMode,
          branch: null,
          worktreePath: null,
          envMode: entry.payload.input.bootstrap?.prepareWorktree ? "worktree" : "local",
          startFromOrigin: entry.payload.input.bootstrap?.prepareWorktree?.startFromOrigin ?? false,
          environmentSelection: "auto",
          loadBalancedEnvironmentId: null,
          queuedForMachine: entry.status === "waiting",
        },
      },
    }));
    useComposerDraftStore
      .getState()
      .setModelSelection(draftId, entry.payload.input.modelSelection, { replaceOptions: true });
  }
  if (entry.status === "waiting")
    useComposerDraftStore.getState().setDraftThreadContext(draftId, { queuedForMachine: true });
  if (entry.status === "bound") {
    const creation = entry.payload.input.bootstrap.createThread;
    const current = useComposerDraftStore.getState().getDraftSession(draftId);
    if (
      current?.environmentId !== entry.payload.environmentId ||
      current.projectId !== creation.projectId ||
      current.loadBalancedEnvironmentId !== entry.payload.environmentId ||
      current.queuedForMachine
    ) {
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(entry.payload.environmentId, creation.projectId),
        environmentSelection: "auto",
        loadBalancedEnvironmentId: entry.payload.environmentId,
        queuedForMachine: false,
      });
    }
    if (
      current?.promotedTo?.environmentId !== entry.payload.environmentId ||
      current.promotedTo.threadId !== entry.payload.input.threadId
    )
      markPromotedDraftThreadByRef(
        scopeThreadRef(entry.payload.environmentId, entry.payload.input.threadId),
      );
  }
  if (entry.status === "cancelled") {
    useComposerDraftStore.getState().setDraftThreadContext(draftId, { queuedForMachine: false });
    const current = useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? "";
    if (!current.includes(entry.prompt))
      useComposerDraftStore
        .getState()
        .setPrompt(draftId, current.trim() ? `${entry.prompt}\n\n${current}` : entry.prompt);
  }
}

export async function cancelThreadCreation(entry: ThreadCreation) {
  if (!(await threadCreationStorage.cancel(entry))) {
    await reloadThreadCreations();
    throw new Error("A machine has already been selected. Open the pending thread to change it.");
  }
  await reconcileThreadCreation({ ...entry, status: "cancelled", revision: entry.revision + 1 });
}

export async function reconcileThreadCreation(entry: ThreadCreation) {
  if (entry.status === "bound") {
    const binding = await threadCreationStorage.loadBinding(entry.id);
    rememberBinding(entry.id, binding);
    const draft = useComposerDraftStore.getState().getDraftSession(DraftId.make(entry.id));
    if (binding?.commandId === entry.payload.input.commandId && (!draft || draft.queuedForMachine))
      recoverThreadCreation(entry);
    else if (binding) recoverBinding(binding);
  } else {
    recoverThreadCreation(entry);
  }
  if (entry.status === "waiting") return;
  if (entry.status === "bound") await webThreadOutbox.reload();
  await threadCreationStorage.remove(entry);
  await reloadThreadCreations();
}

export async function chooseThreadCreationMachine(
  entry: ThreadCreation,
  environmentId: EnvironmentId,
) {
  const project = readProjects().find(
    (project) =>
      project.environmentId === environmentId &&
      threadCreationRoutingKey(project) === entry.routingKey,
  );
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  if (
    !project ||
    !config ||
    !threadCreationProvider(entry, config) ||
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  )
    throw new Error("This machine needs access to the same workspace, provider, and model.");
  if (!(await threadCreationStorage.bind(entry, bindThreadCreation(entry, project), true)))
    throw new Error("The task is already starting on its selected machine.");
  await reloadThreadCreations();
}

export async function drainThreadCreations(options: {
  entries: ReadonlyArray<ThreadCreation>;
  projects: ReadonlyArray<EnvironmentProject>;
  configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  weights: Readonly<Record<string, number>>;
  isConnected: (environmentId: EnvironmentId) => boolean;
  readResources: (environmentId: EnvironmentId) => {
    resources: HostResourcesSnapshot | null;
    receivedAt: number;
  };
  isActive: () => boolean;
}) {
  for (const entry of options.entries) {
    if (!options.isActive()) return;
    await reconcileThreadCreation(entry);
    if (entry.status !== "waiting") continue;
    const candidates = options.projects.filter((project) => {
      const config = options.configs.get(project.environmentId);
      return (
        threadCreationRoutingKey(project) === entry.routingKey &&
        (options.weights[project.environmentId] ?? 50) > 0 &&
        options.isConnected(project.environmentId) &&
        readEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope) &&
        config !== undefined &&
        threadCreationProvider(entry, config) !== null
      );
    });
    const selection = inspectLoadBalancedEnvironments(
      candidates.map((project) => ({
        ...options.readResources(project.environmentId),
        environmentId: project.environmentId,
        weight: options.weights[project.environmentId] ?? 50,
      })),
      Date.now(),
    );
    setThreadCreationReason(
      entry.id,
      {
        selected: "Waiting to start",
        "no-candidates": "Waiting for an eligible machine",
        unavailable: "Machine resource checks unavailable",
        "at-capacity": "Waiting for machine capacity",
      }[selection.status],
    );
    const project = candidates.find((project) => project.environmentId === selection.environmentId);
    if (
      project &&
      options.isActive() &&
      (await threadCreationStorage.bind(entry, bindThreadCreation(entry, project)))
    )
      await reloadThreadCreations();
  }
}
