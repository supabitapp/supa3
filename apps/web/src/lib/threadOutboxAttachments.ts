import type { EnvironmentId } from "@supacode/contracts";
import * as Equal from "effect/Equal";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachment,
  retainAttachmentUploads,
  transferCompletedAttachmentUpload,
} from "./attachmentUploadQueue";
import type { OutboxAttachment } from "../state/threadOutboxSchema";

// Larger files use their host copy instead of a second multi-GB IndexedDB copy.
export const MAX_LOCAL_OUTBOX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export async function captureThreadOutboxAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
}): Promise<Array<typeof OutboxAttachment.Type>> {
  await awaitAttachmentUploads(
    input.attachments
      .filter((attachment) => attachment.sizeBytes > MAX_LOCAL_OUTBOX_ATTACHMENT_BYTES)
      .map((attachment) => attachment.id),
  );
  return input.attachments.map((attachment) => {
    const large = attachment.sizeBytes > MAX_LOCAL_OUTBOX_ATTACHMENT_BYTES;
    const uploaded =
      large || attachment.file === null
        ? getUploadedAttachments({ environmentId: input.environmentId, images: [attachment] })?.[0]
        : undefined;
    if (large && !uploaded)
      throw new Error(`Finish uploading '${attachment.name}' before sending.`);
    if (attachment.file === null && !uploaded)
      throw new Error(`Attach '${attachment.name}' again before sending.`);
    return {
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      bytes: uploaded ? null : attachment.file,
      ...(attachment.source ? { source: attachment.source } : {}),
      ...(uploaded ? { uploaded } : {}),
    };
  });
}

/** Release the draft only after its outbox record has committed. */
export function releaseCapturedDraftAttachments(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
  captured: ReadonlyArray<typeof OutboxAttachment.Type>,
): void {
  for (const attachment of attachments) {
    const upload = captured.find((entry) => entry.id === attachment.id)?.uploaded;
    if (upload) transferCompletedAttachmentUpload(attachment.id);
    else releaseDraftAttachment(attachment);
  }
}

export function retainCapturedAttachmentUploads(
  environmentId: EnvironmentId,
  captured: ReadonlyArray<typeof OutboxAttachment.Type>,
) {
  return retainAttachmentUploads(
    captured.flatMap((attachment) =>
      attachment.uploaded ? [{ environmentId, attachmentId: attachment.uploaded.id }] : [],
    ),
  );
}

function withoutUploadMetadata(file: ComposerFileAttachment) {
  const { uploadedAttachmentId: _, uploadEnvironmentId: __, ...content } = file;
  return content;
}

/** Detach committed attachments while preserving edits made during the upload wait. */
export function completeThreadOutboxDraft(input: {
  readonly target: ComposerThreadTarget;
  readonly submitted: ComposerThreadDraftState | null;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly captured: ReadonlyArray<typeof OutboxAttachment.Type>;
}): boolean {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(input.target);
  const unchanged =
    current === input.submitted ||
    (current !== null &&
      input.submitted !== null &&
      Equal.equals(
        { ...current, files: current.files.map(withoutUploadMetadata) },
        { ...input.submitted, files: input.submitted.files.map(withoutUploadMetadata) },
      ));
  if (unchanged) store.clearComposerContent(input.target);
  else {
    for (const attachment of input.attachments) {
      if (attachment.type === "image") store.removeImage(input.target, attachment.id);
      else store.removeFile(input.target, attachment.id);
    }
  }
  releaseCapturedDraftAttachments(input.attachments, input.captured);
  return unchanged;
}
