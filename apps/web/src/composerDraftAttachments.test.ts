import { draftAttachmentNeedsReattach } from "./composerAttachmentState";
import {
  hydrateComposerDraftAttachments,
  retryComposerDraftAttachments,
} from "./composerDraftAttachments";
import { EnvironmentId } from "@supacode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const records = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
    removeItem: (key: string) => {
      records.delete(key);
    },
  });
  return { records, load: vi.fn(), save: vi.fn() };
});
vi.mock("./state/draftAttachmentBytes", () => ({
  draftAttachmentBytes: {
    load: mocks.load,
    save: mocks.save,
    start: vi.fn(),
    hold: () => () => {},
  },
}));

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  type ComposerFileAttachment,
} from "./composerDraftStore";

const target = DraftId.make("byte-draft");
const bytes = new File(["clipboard bytes"], "notes.txt", { type: "text/plain" });
const attachment: ComposerFileAttachment = {
  type: "file",
  id: "notes",
  name: bytes.name,
  mimeType: bytes.type,
  sizeBytes: bytes.size,
  file: bytes,
};
function draft() {
  return useComposerDraftStore.getState().getComposerDraft(target);
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.records.clear();
  mocks.load.mockReset().mockResolvedValue(null);
  mocks.save.mockReset().mockResolvedValue("cached");
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
});
afterEach(async () => {
  await useComposerDraftStore.persist.clearStorage();
});

describe("draft attachment byte lifecycle", () => {
  it("flushes a new batch once and avoids serialization when revisiting cached attachments", async () => {
    const write = vi.spyOn(localStorage, "setItem");
    try {
      useComposerDraftStore.getState().addFiles(target, [
        attachment,
        {
          ...attachment,
          id: "other",
          name: "other.txt",
          file: new File([bytes], "other.txt", { type: "text/plain" }),
        },
      ]);
      await hydrateComposerDraftAttachments(target);
      expect(write).toHaveBeenCalledTimes(1);
      write.mockClear();
      await hydrateComposerDraftAttachments(target);
      expect(write).not.toHaveBeenCalled();
      expect(draft()?.files.every((file) => file.byteState === "cached")).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it("commits binary bytes and metadata before reporting cached", async () => {
    const commit = deferred<"cached">();
    mocks.save.mockReturnValue(commit.promise);
    useComposerDraftStore.getState().addFiles(target, [attachment]);
    expect(draft()?.files[0]?.byteState).toBe("saving");
    const saved = hydrateComposerDraftAttachments(target);
    commit.resolve("cached");
    await saved;
    expect(draft()?.files[0]?.byteState).toBe("cached");
    expect(mocks.records.get(COMPOSER_DRAFT_STORAGE_KEY)).toContain('"id":"notes"');
    expect(mocks.records.get(COMPOSER_DRAFT_STORAGE_KEY)).not.toContain("clipboard bytes");
  });
  it("waits for cached bytes before declaring a restored file missing", async () => {
    const lookup = deferred<File | null>();
    mocks.load.mockReturnValue(lookup.promise);
    useComposerDraftStore
      .getState()
      .addFiles(target, [{ ...attachment, file: null, byteState: "hydrating" }]);
    expect(draftAttachmentNeedsReattach(draft()!.files[0]!)).toBe(false);
    const restored = hydrateComposerDraftAttachments(target);
    lookup.resolve(bytes);
    await restored;
    expect(draft()?.files[0]?.file).toBe(bytes);
    expect(draft()?.files[0]?.byteState).toBe("cached");
  });
  it("keeps unavailable storage sendable for the current session", async () => {
    mocks.save.mockResolvedValue("session-only");
    useComposerDraftStore.getState().addFiles(target, [attachment]);
    await hydrateComposerDraftAttachments(target);
    expect(draft()?.files[0]?.file).toBe(bytes);
    expect(draft()?.files[0]?.byteState).toBe("session-only");
  });
  it("marks a confirmed cache miss after hydration finishes", async () => {
    useComposerDraftStore
      .getState()
      .addFiles(target, [{ ...attachment, file: null, byteState: "hydrating" }]);
    await hydrateComposerDraftAttachments(target);
    expect(draft()?.files[0]?.byteState).toBe("missing");
    expect(draftAttachmentNeedsReattach(draft()!.files[0]!)).toBe(true);
  });
  it("discards late bytes after their draft is cleared", async () => {
    const lookup = deferred<File | null>();
    mocks.load.mockReturnValue(lookup.promise);
    useComposerDraftStore
      .getState()
      .addFiles(target, [{ ...attachment, file: null, byteState: "hydrating" }]);
    const restored = hydrateComposerDraftAttachments(target);
    useComposerDraftStore.getState().clearComposerPromptAndImages(target);
    lookup.resolve(bytes);
    await restored;
    expect(draft()).toBeNull();
  });
  it("keeps a legacy image fallback until binary storage commits", async () => {
    const commit = deferred<"cached">();
    mocks.save.mockReturnValue(commit.promise);
    const options = useComposerDraftStore.persist.getOptions();
    const legacy = {
      draftsByThreadKey: {
        [target]: {
          prompt: "legacy image",
          attachments: [
            {
              id: "legacy-image",
              name: "clipboard.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
          ],
        },
      },
    };
    const merged = options.merge!(legacy, useComposerDraftStore.getState());
    useComposerDraftStore.setState(merged);
    const saving = hydrateComposerDraftAttachments(target);
    expect(
      partializeComposerDraftStoreState(useComposerDraftStore.getState()).draftsByThreadKey[target]
        ?.attachments[0]?.dataUrl,
    ).toBe("data:image/png;base64,AQID");
    commit.resolve("cached");
    await saving;
    expect(draft()?.images[0]?.byteState).toBe("cached");
    expect(
      partializeComposerDraftStoreState(useComposerDraftStore.getState()).draftsByThreadKey[target]
        ?.attachments[0]?.dataUrl,
    ).toBeUndefined();
  });

  it("retains bytes and reports session-only when metadata cannot flush", async () => {
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    try {
      useComposerDraftStore.getState().addFiles(target, [attachment]);
      await hydrateComposerDraftAttachments(target);
      expect(draft()?.files[0]?.file).toBe(bytes);
      expect(draft()?.files[0]?.byteState).toBe("session-only");
    } finally {
      write.mockRestore();
    }
  });

  it("retries a session-only file without requiring another paste", async () => {
    mocks.save.mockResolvedValueOnce("session-only");
    useComposerDraftStore.getState().addFiles(target, [attachment]);
    await hydrateComposerDraftAttachments(target);
    expect(draft()?.files[0]?.byteState).toBe("session-only");
    await retryComposerDraftAttachments(target);
    expect(draft()?.files[0]?.byteState).toBe("cached");
    expect(draft()?.files[0]?.file).toBe(bytes);
  });

  it("retries a failed cache read without declaring the file missing", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Storage interrupted")).mockResolvedValueOnce(bytes);
    useComposerDraftStore
      .getState()
      .addFiles(target, [{ ...attachment, file: null, byteState: "hydrating" }]);
    await hydrateComposerDraftAttachments(target);
    expect(draft()?.files[0]?.byteState).toBe("restore-failed");
    expect(draftAttachmentNeedsReattach(draft()!.files[0]!)).toBe(false);
    await retryComposerDraftAttachments(target);
    expect(draft()?.files[0]?.byteState).toBe("cached");
    expect(await draft()!.files[0]!.file!.text()).toBe("clipboard bytes");
  });

  it("waits for its own bytes when an attachment is added as another hydration exits", async () => {
    const saveB = deferred<"cached">();
    const started = deferred<void>();
    const itemB = {
      ...attachment,
      id: "b",
      name: "b.txt",
      file: new File(["b"], "b.txt", { type: "text/plain" }),
      sizeBytes: 1,
    };
    mocks.save.mockImplementation((id: string) =>
      id === "b" ? saveB.promise : Promise.resolve("cached"),
    );
    let retryB: Promise<void> | undefined;
    let scheduled = false;
    let settled = false;
    const unsubscribe = useComposerDraftStore.subscribe(() => {
      if (
        scheduled ||
        draft()?.files.find((file) => file.id === attachment.id)?.byteState !== "cached"
      )
        return;
      scheduled = true;
      queueMicrotask(() => {
        useComposerDraftStore.getState().addFiles(target, [itemB]);
        retryB = retryComposerDraftAttachments(target, [itemB.id]).then(() => {
          settled = true;
        });
        started.resolve(undefined);
      });
    });
    try {
      useComposerDraftStore.getState().addFiles(target, [attachment]);
      await started.promise;
      expect(settled).toBe(false);
      expect(draft()?.files.find((file) => file.id === itemB.id)?.byteState).toBe("saving");
      saveB.resolve("cached");
      await retryB;
      expect(draft()?.files.find((file) => file.id === itemB.id)?.byteState).toBe("cached");
    } finally {
      unsubscribe();
    }
  });

  it("preserves a source reference while local bytes are unavailable", async () => {
    useComposerDraftStore.getState().addFiles(target, [
      {
        ...attachment,
        file: null,
        uploadedAttachmentId: "source-upload",
        uploadEnvironmentId: EnvironmentId.make("source"),
      },
    ]);
    await hydrateComposerDraftAttachments(target);
    expect(
      partializeComposerDraftStoreState(useComposerDraftStore.getState()).draftsByThreadKey[target]
        ?.files?.[0]?.attachmentId,
    ).toBe("source-upload");
  });
});
