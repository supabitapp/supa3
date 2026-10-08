import { hydrateComposerDraftAttachments } from "../composerDraftAttachments";
import { EnvironmentId, ProjectId, ThreadId } from "@supacode/contracts";
import { scopeProjectRef, scopeThreadRef } from "@supacode/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import {
  DraftId,
  useComposerDraftStore,
  flushComposerDraftPersistence,
} from "../composerDraftStore";
import { useThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import { releaseDraftAttachments } from "./attachmentUploadQueue";
import { discardComposerDraft } from "./discardComposerDraft";

const cache = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  return {
    storage,
    load: vi.fn(async (): Promise<File | null> => null),
    save: vi.fn(async () => "cached" as const),
  };
});
vi.mock("../state/draftAttachmentBytes", () => ({
  draftAttachmentBytes: {
    load: cache.load,
    save: cache.save,
    start: vi.fn(),
    hold: () => () => {},
  },
}));

vi.mock("./attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));

const environmentId = EnvironmentId.make("environment-local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const draftId = DraftId.make("draft-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

function undoNotice() {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) throw new Error("Undo notice is missing");
  return notice;
}

beforeEach(() => {
  vi.useFakeTimers();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("discardComposerDraft", () => {
  it("restores a discarded new-thread draft with its project mapping", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId);
    store.setPrompt(draftId, "half-written prompt");
    const before = useComposerDraftStore.getState();

    discardComposerDraft(draftId);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(undoNotice()).toMatchObject({ action: "Discarded", count: 1 });

    await undoNotice().undo();
    const after = useComposerDraftStore.getState();
    expect(after.getDraftSession(draftId)).toEqual(before.getDraftSession(draftId));
    expect(after.getComposerDraft(draftId)?.prompt).toBe("half-written prompt");
    expect(after.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual(
      before.logicalProjectDraftThreadKeyByLogicalProjectKey,
    );
    vi.runAllTimers();
    expect(releaseDraftAttachments).not.toHaveBeenCalled();
  });

  it("restores bytes after Undo when the first hydration finished while the draft was discarded", async () => {
    const file = new File(["clipboard"], "notes.txt", { type: "text/plain" });
    let complete!: (file: File) => void;
    const firstLookup = new Promise<File>((resolve) => {
      complete = resolve;
    });
    cache.load.mockReturnValueOnce(firstLookup).mockResolvedValueOnce(file);
    useComposerDraftStore.getState().addFiles(threadRef, [
      {
        type: "file",
        id: "undo-file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file: null,
        byteState: "hydrating",
      },
    ]);
    const hydration = hydrateComposerDraftAttachments(threadRef);
    discardComposerDraft(threadRef);
    complete(file);
    await hydration;
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)).toBeNull();
    await undoNotice().undo();
    const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)?.files[0];
    expect(restored?.byteState).toBe("cached");
    expect(await restored?.file?.text()).toBe("clipboard");
  });

  it("retains restored bytes as session-only when Undo cannot persist the restored metadata", async () => {
    const file = new File(["saved bytes"], "notes.txt", { type: "text/plain" });
    useComposerDraftStore.getState().addFiles(threadRef, [
      {
        type: "file",
        id: "cached-undo",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ]);
    await hydrateComposerDraftAttachments(threadRef);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.files[0]?.byteState).toBe(
      "cached",
    );
    discardComposerDraft(threadRef);
    expect(flushComposerDraftPersistence()).toBe(true);
    const write = vi.spyOn(cache.storage, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    try {
      await undoNotice().undo();
      const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)?.files[0];
      expect(restored?.byteState).toBe("session-only");
      expect(await restored?.file?.text()).toBe("saved bytes");
    } finally {
      write.mockRestore();
    }
  });

  it("clears a thread draft for good and releases its uploads once undo expires", async () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "reply in progress");

    discardComposerDraft(threadRef);
    const notice = undoNotice();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
    expect(releaseDraftAttachments).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(releaseDraftAttachments).toHaveBeenCalledOnce();
    await notice.undo();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
  });

  it("keeps text typed after the discard and releases the old uploads", async () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "old reply");
    discardComposerDraft(threadRef);
    useComposerDraftStore.getState().setPrompt(threadRef, "new reply");
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("error-toast");

    await undoNotice().undo();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe("new reply");
    expect(releaseDraftAttachments).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to restore draft" }),
    );
  });
});
