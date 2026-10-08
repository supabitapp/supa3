import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { PromptStashEntry } from "../promptStashStore";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
} from "./composerContextReferences";
import { EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@supacode/contracts";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerImageAttachment,
} from "../composerDraftStore";
import { restoreStashAttachments } from "./restoreStashAttachments";
vi.mock("../state/draftAttachmentBytes", () => ({
  draftAttachmentBytes: { save: async () => "cached", load: async () => null },
}));
const target = DraftId.make("stash-restore");
beforeEach(() =>
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} }),
);
function draft() {
  return useComposerDraftStore.getState().getComposerDraft(target)!;
}

function restore(
  entry: PromptStashEntry,
  existing: ComposerImageAttachment[],
  capacity: number,
  createId?: () => string,
) {
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Existing text");
  const fillers: ComposerImageAttachment[] = Array.from(
    { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - capacity - existing.length },
    (_, i) => ({
      type: "image",
      id: `filler-${i}`,
      name: `filler-${i}.png`,
      mimeType: "image/png",
      sizeBytes: 1,
      file: null,
      byteState: "missing",
      previewUrl: "",
    }),
  );
  useComposerDraftStore.setState({
    draftsByThreadKey: { [target]: { ...draft(), images: [...existing, ...fillers] } },
  });
  return restoreStashAttachments(entry, target, new Set(), createId);
}

it("restores a compressed image under a fresh id and rewrites its prompt and annotation links", () => {
  const imageId = toKindScopedComposerContextId("image", "original");
  const annotationId = toKindScopedComposerContextId("preview-annotation", "original");
  const entry: PromptStashEntry = {
    id: "stash",
    createdAt: "2026-10-08T00:00:00.000Z",
    droppedImageNames: [],
    prompt: `${formatInlineContextReference({ kind: "image", contextId: imageId, label: "image" })} ${formatInlineContextReference({ kind: "preview-annotation", contextId: annotationId, label: "annotation" })}`,
    attachments: [
      {
        id: "original",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,AQID",
      },
    ],
    records: [
      {
        version: 1,
        kind: "preview-annotation",
        contextId: annotationId,
        label: "annotation",
        annotationId: "original",
        pageUrl: "https://example.test",
        pageTitle: null,
        comment: "change",
        targetSummary: "page",
        styleChanges: [],
        screenshotContextId: imageId,
      },
    ],
  };
  const restored = restore(entry, [], 20, () => "restored");
  expect(draft().images.find((image) => image.id === "restored")?.file?.size).toBe(3);
  expect(restored.prompt).toContain(toKindScopedComposerContextId("image", "restored"));
  expect(restored.prompt).toContain(
    toKindScopedComposerContextId("preview-annotation", "restored"),
  );
  expect(restored.records?.[0]).toMatchObject({
    annotationId: "restored",
    screenshotContextId: toKindScopedComposerContextId("image", "restored"),
  });
  expect(entry.attachments[0]?.id).toBe("original");
});

const stashImage = {
  id: "stashed",
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,AQID",
};
const stash: PromptStashEntry = {
  id: "stash",
  createdAt: "2026-10-08T00:00:00.000Z",
  droppedImageNames: [],
  prompt: formatInlineContextReference({
    kind: "image",
    contextId: toKindScopedComposerContextId("image", "stashed"),
    label: "image",
  }),
  attachments: [stashImage],
};

it("rewrites a deduplicated stash reference to the retained image without consuming a slot", () => {
  const existing = {
    ...stashImage,
    id: "retained",
    type: "image" as const,
    file: new File([new Uint8Array([1, 2, 3])], stashImage.name),
    previewUrl: "blob:retained",
  };
  const entry = restore(stash, [existing], 0);
  expect(draft().images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  expect(entry.prompt).toContain("image_retained");
  expect(entry.prompt).not.toContain("image_stashed");
  expect(entry.skippedImageNames).toEqual([]);
});

it("keeps a live original when a non-durable stash removal reappears with compressed bytes", () => {
  const existing = {
    ...stashImage,
    type: "image" as const,
    sizeBytes: 100,
    file: new File(["original bytes"], stashImage.name),
    previewUrl: "blob:original",
  };
  const entry = restore(stash, [existing], 0);
  expect(draft().images.find((image) => image.id === existing.id)?.file).toBe(existing.file);
  expect(entry.prompt).toBe(stash.prompt);
});

it("replaces unavailable stash images under fresh IDs without consuming a slot", () => {
  const existing = {
    ...stashImage,
    type: "image" as const,
    file: null,
    previewUrl: "",
    byteState: "restore-failed" as const,
  };
  const entry = restore(stash, [existing], 0, () => "fresh");
  expect(draft().images.find((image) => image.name === stashImage.name)?.id).toBe("fresh");
  expect(entry.prompt).toContain("image_fresh");
  expect(entry.skippedImageNames).toEqual([]);
});

it("reports capacity overflow and removes its image reference", () => {
  const entry = restore(stash, [], 0, () => "fresh");
  expect(draft().images.some((image) => image.id === "fresh")).toBe(false);
  expect(entry.prompt).toBe("");
  expect(entry.skippedImageNames).toEqual([stashImage.name]);
});

it("keeps an overflowing annotation while removing its unavailable screenshot link", () => {
  const imageId = toKindScopedComposerContextId("image", stashImage.id);
  const annotationId = toKindScopedComposerContextId("preview-annotation", stashImage.id);
  const entry: PromptStashEntry = {
    ...stash,
    prompt:
      stash.prompt +
      " " +
      formatInlineContextReference({
        kind: "preview-annotation",
        contextId: annotationId,
        label: "note",
      }),
    records: [
      {
        version: 1,
        kind: "preview-annotation",
        contextId: annotationId,
        label: "note",
        annotationId: stashImage.id,
        pageUrl: "https://example.test",
        pageTitle: null,
        comment: "change",
        targetSummary: "page",
        styleChanges: [],
        screenshotContextId: imageId,
      },
    ],
  };
  const restored = restore(entry, [], 0, () => "fresh");
  expect(restored.prompt).not.toContain("/image/");
  expect(restored.prompt).toContain("preview-annotation_fresh");
  expect(restored.records?.[0]).toMatchObject({ annotationId: "fresh" });
  expect(restored.records?.[0]).not.toHaveProperty("screenshotContextId");
});

it("repairs an unavailable image under a fresh id when a live duplicate also exists", () => {
  const unavailable = {
    ...stashImage,
    id: "missing",
    type: "image" as const,
    file: null,
    previewUrl: "",
    byteState: "missing" as const,
  };
  const live = {
    ...unavailable,
    id: "live",
    file: new File(["abc"], stashImage.name),
    previewUrl: "blob:live",
  };
  const entry = restore(stash, [live, unavailable], 0, () => "fresh");
  expect(draft().images.find((image) => image.id === "fresh")?.file).not.toBeNull();
  expect(draft().images.some((image) => image.id === "missing")).toBe(false);
  expect(entry.prompt).toContain("image_fresh");
});

it("restores files before images and rewrites a mixed stash once at capacity", () => {
  const entry: PromptStashEntry = {
    ...stash,
    prompt: "[file](supacode-context://v1/file/file_report) " + stash.prompt,
    files: [
      {
        id: "report",
        name: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
        attachmentId: "uploaded-report",
        environmentId: EnvironmentId.make("source"),
      },
    ],
  };
  const result = restore(entry, [], 1);
  const restoredFile = draft().files[0]!;
  expect(restoredFile.uploadedAttachmentId).toBe("uploaded-report");
  expect(result.prompt).toContain(`file_${restoredFile.id}`);
  expect(result.prompt).not.toContain("image_stashed");
  expect(result.skippedImageNames).toEqual([stashImage.name]);
  expect(draft().images.length + draft().files.length).toBe(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
});

it("retains an undecodable stash image as an actionable missing row", () => {
  const result = restore(
    { ...stash, attachments: [{ ...stashImage, dataUrl: "data:image/png;base64,invalid!" }] },
    [],
    1,
    () => "invalid-image",
  );
  const image = draft().images.find((item) => item.id === "invalid-image");
  expect(image).toMatchObject({ file: null, byteState: "missing", previewUrl: "" });
  expect(result.prompt).toContain("image_invalid-image");
});

it("restores an expired duplicate and its surviving upload to one recoverable file", () => {
  const file = {
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 6,
    environmentId: EnvironmentId.make("source"),
  };
  const entry: PromptStashEntry = {
    ...stash,
    attachments: [],
    files: [
      { ...file, id: "expired-one", attachmentId: "expired-one" },
      { ...file, id: "expired-two", attachmentId: "expired-two" },
      { ...file, id: "survivor", attachmentId: "available-upload" },
    ],
    prompt: ["expired-one", "expired-two", "survivor"]
      .map((id) => `[report](supacode-context://v1/file/file_${id})`)
      .join(" "),
  };
  let sequence = 0;
  const result = restoreStashAttachments(
    entry,
    target,
    new Set(["expired-one", "expired-two"]),
    () => `fresh-${++sequence}`,
  );
  expect(draft().files).toHaveLength(1);
  expect(draft().files[0]).toMatchObject({
    id: "fresh-3",
    uploadedAttachmentId: "available-upload",
  });
  expect(result.prompt.match(/file_fresh-3/g)).toHaveLength(3);
  expect(result.prompt).not.toContain("file_fresh-1");
  expect(result.expiredFileNames).toEqual([]);
});

it("repairs an undecodable image added earlier in the same stash batch", async () => {
  const entry: PromptStashEntry = {
    ...stash,
    attachments: [
      { ...stashImage, id: "unreadable", dataUrl: "data:image/png;base64,invalid!" },
      { ...stashImage, id: "recoverable" },
    ],
    prompt:
      "[first](supacode-context://v1/image/image_unreadable) [second](supacode-context://v1/image/image_recoverable)",
  };
  let sequence = 0;
  const result = restoreStashAttachments(entry, target, new Set(), () => `fresh-${++sequence}`);
  expect(draft().images).toHaveLength(1);
  expect(draft().images[0]?.id).toBe("fresh-2");
  expect(await draft().images[0]?.file?.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  expect(result.prompt.match(/image_fresh-2/g)).toHaveLength(2);
  expect(result.prompt).not.toContain("image_fresh-1");
});
