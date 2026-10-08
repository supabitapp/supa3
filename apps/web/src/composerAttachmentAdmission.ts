import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@supacode/contracts";
import { videoMimeType } from "@supacode/shared/video";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";

import { draftAttachmentNeedsReattach } from "./composerAttachmentState";

type Attachment = ComposerImageAttachment | ComposerFileAttachment;
export interface ComposerAttachmentPlan<A extends Attachment> {
  attachments: A[];
  admitted: A[];
  rejected: A[];
  survivorIds: Map<string, string>;
}

export function composerAttachmentDedupKey(
  attachment: Pick<Attachment, "mimeType" | "sizeBytes" | "name">,
) {
  return `${attachment.mimeType}\u0000${attachment.sizeBytes}\u0000${attachment.name}`;
}

function composerFileMatchesReattachMarker(
  marker: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
) {
  if (marker.name !== file.name || marker.sizeBytes !== file.sizeBytes) return false;
  if (marker.mimeType === file.mimeType) return true;
  const mimeType = marker.mimeType.toLowerCase();
  return (
    (mimeType === "" || mimeType === "application/octet-stream") &&
    videoMimeType(marker) !== null &&
    videoMimeType(file) !== null
  );
}

export function planComposerAttachments<A extends Attachment>(
  existing: ReadonlyArray<A>,
  totalCount: number,
  incoming: ReadonlyArray<A>,
  options?: { allowDuplicates?: boolean; sourceIds?: ReadonlyMap<string, string> },
): ComposerAttachmentPlan<A> {
  const attachments = [...existing];
  const existingIds = new Set(existing.map((item) => item.id));
  const survivorIds = new Map(existing.map((item) => [item.id, item.id]));
  const rejected: A[] = [];
  for (const attachment of incoming) {
    const sameId = attachments.find((item) => item.id === attachment.id);
    if (sameId) {
      survivorIds.set(attachment.id, sameId.id);
      continue;
    }
    const sourceId = options?.sourceIds?.get(attachment.id);
    const duplicate = options?.allowDuplicates
      ? undefined
      : (attachments.find((item) => sourceId && item.id === sourceId) ??
        attachments.find(
          (item) =>
            item.file === null &&
            (item.type === "image" && attachment.type === "image"
              ? item.name === attachment.name && item.mimeType === attachment.mimeType
              : item.type === "file" &&
                attachment.type === "file" &&
                composerFileMatchesReattachMarker(item, attachment)),
        ) ??
        attachments.find(
          (item) => composerAttachmentDedupKey(item) === composerAttachmentDedupKey(attachment),
        ));
    if (duplicate) {
      const canReplace =
        duplicate.file === null &&
        (attachment.file !== null ||
          (attachment.type === "file" &&
            attachment.uploadedAttachmentId !== undefined &&
            draftAttachmentNeedsReattach(duplicate)));
      if (!canReplace) {
        survivorIds.set(attachment.id, duplicate.id);
        continue;
      }
      attachments[attachments.indexOf(duplicate)] = attachment;
      for (const [id, survivorId] of survivorIds) {
        if (survivorId === duplicate.id) survivorIds.set(id, attachment.id);
      }
    } else {
      if (totalCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        rejected.push(attachment);
        continue;
      }
      attachments.push(attachment);
      totalCount += 1;
    }
    survivorIds.set(attachment.id, attachment.id);
  }
  return {
    attachments,
    admitted: attachments.filter((item) => !existingIds.has(item.id)),
    rejected,
    survivorIds,
  };
}
