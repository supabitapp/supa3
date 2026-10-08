import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@supacode/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@supacode/client-runtime/state/attachments";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";

import { draftAttachmentNeedsAttention } from "../../composerAttachmentState";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import { isHeicImageFile } from "../../lib/imageCompression";
import { isVideoAttachment, videoMimeType } from "../../types";
import { randomUUID } from "../../lib/randomUUID";

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

export function composerImagesForAttachmentTray(
  images: ReadonlyArray<ComposerImageAttachment>,
  annotations: ReadonlyArray<{ readonly id: string }>,
  uploads: Readonly<Record<string, AttachmentUploadState>>,
): ComposerImageAttachment[] {
  const annotationIds = new Set(annotations.map((annotation) => annotation.id));
  return images.filter(
    (image) =>
      !annotationIds.has(image.id) || draftAttachmentNeedsAttention(image, uploads[image.id]),
  );
}

interface FileAttachmentCapabilityState {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over
 * a `File` with an empty or generic MIME type. Maps the extension to a
 * provider-supported image type so a plain `photo.jpg` still lands on the
 * image path; anything unrecognized stays a generic file.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

/** Give extension-recognized images a concrete type before compression. */
export function normalizeComposerImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  return isProviderSendTurnSupportedImageMimeType(file.type) ? "image" : "unsupported-image";
}

export function prepareComposerAttachmentFiles(input: {
  readonly files: ReadonlyArray<File>;
  readonly attachments: ReadonlyArray<ComposerFileAttachment | ComposerImageAttachment>;
  readonly reservedCount: number;
  readonly fileStagingLimit: number | null;
  readonly pendingImageCount?: number;
  readonly source?: ComposerFileAttachment["source"];
}) {
  let reservedCount = input.reservedCount;
  let potentialImageSlots = Math.max(
    0,
    input.attachments.filter((item) => item.type === "image" && item.file === null).length -
      (input.pendingImageCount ?? 0),
  );
  const images: File[] = [];
  const files: ComposerFileAttachment[] = [];
  let error: string | null = null;
  for (const file of input.files) {
    const kind = classifyComposerAttachmentFile(file);
    if (kind === "unsupported-image") {
      error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
      continue;
    }
    const normalized = kind === "image" ? normalizeComposerImageFileMimeType(file) : file;
    const mimeType =
      kind === "image"
        ? normalized.type
        : (videoMimeType({ name: file.name, mimeType: file.type }) ??
          (file.type || "application/octet-stream"));
    const descriptor = {
      name: file.name || (kind === "image" ? "image" : "file"),
      mimeType,
      sizeBytes: file.size,
    };
    if (kind === "image") {
      if (reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        if (potentialImageSlots === 0) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
          continue;
        }
        potentialImageSlots -= 1;
      } else reservedCount += 1;
      images.push(normalized);
    } else {
      if (input.fileStagingLimit === null) {
        error = "This server does not support file attachments.";
        continue;
      }
      if (file.size <= 0) {
        error = `'${file.name}' is empty or could not be read.`;
        continue;
      }
      if (file.size > input.fileStagingLimit) {
        error = fileAttachmentTooLargeMessage(file.name, input.fileStagingLimit);
        continue;
      }
      const attachmentFile =
        file.type === mimeType
          ? file
          : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
      const attachment: ComposerFileAttachment = {
        type: "file",
        id: randomUUID(),
        ...descriptor,
        file: attachmentFile,
        ...(input.source ? { source: input.source } : {}),
      };
      files.push(attachment);
    }
  }
  return { images, files, error };
}

export function isPreviewableComposerVideo(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): boolean {
  return (
    isVideoAttachment(file) &&
    (file.file !== null ||
      (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId))
  );
}

/** Non-media files without an inline reference still need the legacy attachment row. */
export function composerOtherFilesForPresentation(
  files: ReadonlyArray<ComposerFileAttachment>,
  environmentId: EnvironmentId,
  inlineFileIds: ReadonlySet<string>,
): ComposerFileAttachment[] {
  return files.filter(
    (file) => !isPreviewableComposerVideo(file, environmentId) && !inlineFileIds.has(file.id),
  );
}

/** Byte limit for adding a generic file to the local composer draft. */
export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.attachmentUploadsCapabilityKnown) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  if (!input.supportsAttachmentUploads || input.maxFileAttachmentBytes === null) {
    return null;
  }
  return clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
}

/**
 * When `capabilities.attachmentUploads` flips off (reconnect, version skew),
 * tear down only uploads that have not been persisted onto a draft file.
 * Once `uploadedAttachmentId` is stamped, the draft references that server
 * copy after reload even if its local `File` is still available in memory.
 * Explicit attachment removal releases persisted uploads through
 * `releaseDraftAttachment`.
 */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

/**
 * Whether a paste's files should be claimed as composer attachments instead of
 * falling through to the default text paste. Deliberately no capacity or
 * pending-plan-question gate here: `addComposerAttachments` owns those limits
 * and reports them, while a gate at this layer would swallow the paste with no
 * feedback.
 */
export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      const classification = classifyComposerAttachmentFile(file);
      return classification === "image" || classification === "unsupported-image";
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
}
