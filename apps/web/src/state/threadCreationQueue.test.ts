import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@supacode/contracts";

import {
  DraftId,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  cancelThreadCreation,
  recoverThreadCreation,
  reloadThreadCreations,
  reconcileThreadCreation,
} from "./threadCreationQueue";
import { creation } from "./threadCreationTestFixtures";
import type { ThreadCreationBinding } from "./threadCreationStorage";

const storageState = vi.hoisted(() => ({ binding: null as ThreadCreationBinding | null }));

vi.mock("./threadOutbox", () => ({
  prepareThreadOutboxTurn: vi.fn(),
  webThreadOutbox: { reload: vi.fn() },
}));
vi.mock("./entities", () => ({ readProjects: () => [] }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("./session", () => ({ readEnvironmentScope: () => false }));
vi.mock("./threadCreationStorage", () => ({
  threadCreationStorage: {
    load: async () => [],
    loadBinding: async () => storageState.binding,
    readState: async () => ({ creation: null, binding: storageState.binding }),
    cancel: async () => true,
    remove: async () => undefined,
  },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));

beforeEach(() => {
  storageState.binding = null;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

describe("durable creation recovery", () => {
  it("does not re-promote a cancelled outbox draft from a surviving bound snapshot", async () => {
    const entry = { ...creation("cancelled-bound"), status: "bound" as const };
    recoverThreadCreation(entry);
    const draftId = DraftId.make(entry.id);
    const draft = useComposerDraftStore.getState().getDraftSession(draftId)!;
    restoreFailedBackgroundDraftThread(draftId, draft, draft.threadId);
    storageState.binding = null;
    await reconcileThreadCreation(entry);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.queuedForMachine).toBe(false);
  });
  it("repairs a submitting tab that first reads after another tab cleaned up the bound request", async () => {
    const entry = creation("late-tab");
    recoverThreadCreation(entry);
    storageState.binding = {
      id: entry.id,
      commandId: entry.payload.input.commandId,
      environmentId: EnvironmentId.make("destination"),
      projectId: ProjectId.make("destination-project"),
      threadId: entry.payload.input.threadId,
    };
    await reloadThreadCreations();
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make(entry.id))).toMatchObject({
      environmentId: "destination",
      projectId: "destination-project",
      queuedForMachine: false,
      promotedTo: { environmentId: "destination", threadId: entry.payload.input.threadId },
    });
  });

  it("clears an orphaned waiting marker while preserving newer unsent content", async () => {
    const entry = creation("cancelled-elsewhere");
    recoverThreadCreation(entry);
    useComposerDraftStore.getState().setPrompt(DraftId.make(entry.id), "Newer draft");
    await reloadThreadCreations();
    expect(
      useComposerDraftStore.getState().getDraftSession(DraftId.make(entry.id))?.queuedForMachine,
    ).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(DraftId.make(entry.id))?.prompt).toBe(
      "Newer draft",
    );
  });
  it("restores Edit locally even when another tab has already removed the cancelled row", async () => {
    const entry = creation();
    await cancelThreadCreation(entry);
    expect(useComposerDraftStore.getState().getComposerDraft(DraftId.make(entry.id))?.prompt).toBe(
      entry.prompt,
    );
    expect(
      useComposerDraftStore.getState().getDraftSession(DraftId.make(entry.id))?.queuedForMachine,
    ).toBe(false);
  });
  it("reconstructs a missing draft under the original pending identity", () => {
    const entry = creation();
    recoverThreadCreation(entry);
    const state = useComposerDraftStore.getState();
    expect(state.getDraftSession(DraftId.make(entry.id))).toMatchObject({
      threadId: entry.payload.input.threadId,
      environmentId: entry.sourceEnvironmentId,
      projectId: entry.sourceProjectId,
    });
    recoverThreadCreation(entry);
    expect(useComposerDraftStore.getState()).toBe(state);
  });

  it("restores a bound destination without repeatedly publishing recovery writes", () => {
    const original = creation();
    const entry = {
      ...original,
      status: "bound" as const,
      payload: {
        ...original.payload,
        environmentId: EnvironmentId.make("destination"),
        input: {
          ...original.payload.input,
          bootstrap: {
            createThread: {
              ...original.payload.input.bootstrap.createThread,
              projectId: ProjectId.make("destination-project"),
            },
          },
        },
      },
    };
    recoverThreadCreation(entry);
    const state = useComposerDraftStore.getState();
    expect(state.getDraftSession(DraftId.make(entry.id))).toMatchObject({
      environmentId: "destination",
      projectId: "destination-project",
      promotedTo: { environmentId: "destination", threadId: entry.payload.input.threadId },
    });
    recoverThreadCreation(entry);
    expect(useComposerDraftStore.getState()).toBe(state);
  });

  it("recovers a cancelled prompt without overwriting newer composer content", () => {
    const entry = { ...creation(), status: "cancelled" as const };
    recoverThreadCreation(entry);
    useComposerDraftStore.getState().setPrompt(DraftId.make(entry.id), "Newer draft");
    recoverThreadCreation(entry);
    expect(useComposerDraftStore.getState().getComposerDraft(DraftId.make(entry.id))?.prompt).toBe(
      "Saved prompt\n\nNewer draft",
    );
    recoverThreadCreation(entry);
    expect(useComposerDraftStore.getState().getComposerDraft(DraftId.make(entry.id))?.prompt).toBe(
      "Saved prompt\n\nNewer draft",
    );
  });
});
