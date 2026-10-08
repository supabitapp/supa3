import { replaceComposerContextReferences } from "@supacode/shared/composerContextReferences";
import type { PromptStashEntry } from "../promptStashStore";
import {
  useComposerDraftStore,
  type ComposerThreadTarget,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../composerDraftStore";
import { draftAttachmentNeedsReattach } from "../composerAttachmentState";
import { randomUUID } from "./randomUUID";
import { dataUrlToFile } from "./imageCompression";
import {
  formatInlineContextReference,
  attachmentContextIdReplacements,
  toKindScopedComposerContextId,
} from "./composerContextReferences";

export function restoreStashAttachments(
  entry: PromptStashEntry,
  target: ComposerThreadTarget,
  expiredAttachmentIds: ReadonlySet<string> = new Set(),
  createId = randomUUID,
) {
  const sourceIds = new Map<string, string>();
  const freshId = (originalId: string) => {
    const id = createId();
    sourceIds.set(id, originalId);
    return id;
  };
  const expiredFileIds = new Set<string>();
  const fileCandidates = (entry.files ?? []).map(
    (file): { sourceId: string; attachment: ComposerFileAttachment } => {
      const expired = expiredAttachmentIds.has(file.attachmentId);
      const id = freshId(file.id);
      if (expired) expiredFileIds.add(id);
      return {
        sourceId: file.id,
        attachment: {
          type: "file",
          id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          file: null,
          ...(file.source ? { source: file.source } : {}),
          ...(expired
            ? { byteState: "missing" }
            : {
                uploadedAttachmentId: file.attachmentId,
                uploadEnvironmentId: file.environmentId,
              }),
        } satisfies ComposerFileAttachment,
      };
    },
  );
  const imageCandidates = entry.attachments.map(
    (image): { sourceId: string; attachment: ComposerImageAttachment } => {
      let file: File | null;
      try {
        file = dataUrlToFile(image.dataUrl, image.name, image.mimeType);
        if (file.size === 0) file = null;
      } catch {
        file = null;
      }
      return {
        sourceId: image.id,
        attachment: {
          type: "image",
          id: freshId(image.id),
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: file?.size ?? image.sizeBytes,
          file,
          byteState: file ? "saving" : "missing",
          previewUrl: file ? URL.createObjectURL(file) : "",
          ...(image.source ? { source: image.source } : {}),
        } satisfies ComposerImageAttachment,
      };
    },
  );
  const files = fileCandidates.map((candidate) => candidate.attachment);
  const images = imageCandidates.map((candidate) => candidate.attachment);
  const store = useComposerDraftStore.getState();
  const filePlan = store.addFiles(target, files, { sourceIds });
  const imagePlan = store.addImages(target, images, { sourceIds });
  const survivorIds = new Map([...filePlan.survivorIds, ...imagePlan.survivorIds]);
  const fileIds = new Map<string, string>();
  const imageIds = new Map<string, string>();
  const skippedIds = new Set<string>();
  const skippedImageNames: string[] = [];
  const skippedFileNames: string[] = [];
  for (const { sourceId, attachment } of [...fileCandidates, ...imageCandidates]) {
    const id = survivorIds.get(attachment.id);
    const kind = attachment.type;
    if (kind === "image") imageIds.set(sourceId, id ?? attachment.id);
    if (id === undefined) {
      skippedIds.add(toKindScopedComposerContextId(kind, sourceId));
      (kind === "image" ? skippedImageNames : skippedFileNames).push(attachment.name);
    } else if (kind === "file") fileIds.set(sourceId, id);
  }
  const contextIds = new Map([
    ...attachmentContextIdReplacements("image", imageIds),
    ...attachmentContextIdReplacements("file", fileIds),
  ]);
  const prompt = replaceComposerContextReferences(entry.prompt, (reference) => {
    if (skippedIds.has(reference.contextId)) return "";
    const contextId = contextIds.get(reference.contextId);
    return contextId ? formatInlineContextReference({ ...reference, contextId }) : reference.source;
  });
  const records = entry.records
    ?.map((record) => {
      if ("payload" in record) return record;
      if (skippedIds.has(record.contextId)) return null;
      const contextId = contextIds.get(record.contextId) ?? record.contextId;
      if (record.kind !== "preview-annotation") return { ...record, contextId };
      const { screenshotContextId, ...annotation } = record;
      return {
        ...annotation,
        contextId,
        annotationId: imageIds.get(record.annotationId) ?? record.annotationId,
        ...(screenshotContextId && !skippedIds.has(screenshotContextId)
          ? { screenshotContextId: contextIds.get(screenshotContextId) ?? screenshotContextId }
          : {}),
      };
    })
    .filter((record) => record !== null);
  const unusedFiles = files.filter((file) => survivorIds.get(file.id) !== file.id);
  const restoredFiles = new Map(
    store.getComposerDraft(target)?.files.map((file) => [file.id, file]),
  );
  const expiredFileNames = files.flatMap((candidate) => {
    if (!expiredFileIds.has(candidate.id)) return [];
    const id = survivorIds.get(candidate.id);
    const file = id === undefined ? undefined : restoredFiles.get(id);
    return file && draftAttachmentNeedsReattach(file) ? [file.name] : [];
  });
  return { prompt, records, skippedImageNames, skippedFileNames, expiredFileNames, unusedFiles };
}
