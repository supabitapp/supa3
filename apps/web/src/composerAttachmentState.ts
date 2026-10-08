import type { ComposerAttachmentPlan } from "./composerAttachmentAdmission";
import type { EnvironmentId } from "@supacode/contracts";
import type { AttachmentRequirement } from "@supacode/client-runtime/state/attachments";
import type { ComposerImageAttachment, ComposerFileAttachment } from "./composerDraftStore";
import {
  formatAttachmentUploadProgress,
  type AttachmentUploadState,
} from "./lib/attachmentUploadState";

type Attachment = ComposerImageAttachment | ComposerFileAttachment;

export type DraftAttachmentByteState =
  | "restore-failed"
  | "hydrating"
  | "saving"
  | "cached"
  | "session-only"
  | "missing";

export function hasDraftAttachmentFile<A extends Attachment>(
  attachment: A,
): attachment is A & { file: File } {
  return attachment.file !== null;
}

export function canRetryDraftAttachment(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
): boolean {
  return attachment.byteState === "session-only" || attachment.byteState === "restore-failed";
}

export function markDraftAttachmentForPersistence<
  A extends ComposerImageAttachment | ComposerFileAttachment,
>(attachment: A): A {
  return {
    ...attachment,
    byteState:
      attachment.byteState === "cached"
        ? "saving"
        : (attachment.byteState ?? (attachment.file ? "saving" : "hydrating")),
  };
}

export function markAttachmentPlanForPersistence<A extends Attachment>(
  plan: ComposerAttachmentPlan<A>,
) {
  const admitted = plan.admitted.map(markDraftAttachmentForPersistence);
  const byId = new Map(admitted.map((item) => [item.id, item]));
  return {
    ...plan,
    admitted,
    attachments: plan.attachments.map((item) => byId.get(item.id) ?? item),
  };
}

export function draftAttachmentNeedsReattach(attachment: Attachment) {
  return (
    attachment.file === null &&
    (attachment.byteState === "missing" || attachment.byteState === undefined) &&
    (attachment.type === "image" || attachment.uploadedAttachmentId === undefined)
  );
}

export function isDraftAttachmentRestoring(attachment: Attachment) {
  return attachment.byteState === "hydrating";
}

export function draftAttachmentNeedsHydration(attachment: Attachment) {
  return attachment.file === null
    ? isDraftAttachmentRestoring(attachment)
    : attachment.byteState === "saving" || attachment.byteState === undefined;
}

export function draftAttachmentNeedsAttention(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  upload?: AttachmentUploadState,
) {
  return (
    draftAttachmentNeedsReattach(attachment) ||
    canRetryDraftAttachment(attachment) ||
    upload?.status === "failed"
  );
}

export function draftAttachmentRetry(attachment: ComposerImageAttachment | ComposerFileAttachment) {
  if (!canRetryDraftAttachment(attachment)) return null;
  return {
    label: attachment.file ? "Retry saving" : "Retry restoring",
    description: attachment.file
      ? "Session-only: this attachment may be lost after a reload. Click to retry saving."
      : "This attachment could not be restored. Click to retry restoring it.",
  };
}

export function draftAttachmentRetryOptions(
  attachment: Attachment,
  upload?: AttachmentUploadState,
) {
  const options: { kind: "persistence" | "upload"; label: string }[] = [];
  const persistence = draftAttachmentRetry(attachment);
  if (persistence) options.push({ kind: "persistence", label: `${persistence.label} attachment` });
  if (upload?.status === "failed" && attachment.byteState !== "restore-failed")
    options.push({ kind: "upload", label: "Retry uploading attachment" });
  return options;
}

export function draftAttachmentStatus(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  upload: AttachmentUploadState | undefined,
): string | null {
  if (draftAttachmentNeedsReattach(attachment)) return "Attach again";
  if (upload?.status === "failed") return "Upload failed";
  if (upload?.status === "uploading") return formatAttachmentUploadProgress(upload.progress);
  if (attachment.byteState === "restore-failed") return "Retry restoring";
  if (isDraftAttachmentRestoring(attachment)) return "Restoring…";
  if (attachment.byteState === "saving") return "Saving…";
  if (attachment.byteState === "session-only") return "Session-only";
  return null;
}
export function draftAttachmentRequirement(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  readable: (environmentId: EnvironmentId) => boolean,
): AttachmentRequirement {
  const requirement = {
    type: attachment.type,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
  };
  if (isDraftAttachmentRestoring(attachment))
    return { ...requirement, source: { kind: "unresolved" } };
  if (attachment.byteState === "restore-failed")
    return { ...requirement, source: { kind: "restore-failed" } };
  if (attachment.file) return { ...requirement, source: { kind: "local" } };
  if (
    attachment.type === "file" &&
    attachment.uploadEnvironmentId &&
    attachment.uploadedAttachmentId
  )
    return {
      ...requirement,
      source: {
        kind: "remote",
        environmentId: attachment.uploadEnvironmentId,
        readable: readable(attachment.uploadEnvironmentId),
      },
    };
  return { ...requirement, source: { kind: "missing" } };
}
