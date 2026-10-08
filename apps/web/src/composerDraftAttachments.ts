import { draftAttachmentNeedsHydration, canRetryDraftAttachment } from "./composerAttachmentState";
import {
  flushComposerDraftPersistence,
  readPersistedDraftAttachmentIds,
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "./composerDraftStore";
import { draftAttachmentBytes } from "./state/draftAttachmentBytes";

const hydrations = new Map<string, Promise<void>>();
type Attachment = ComposerImageAttachment | ComposerFileAttachment;

function updateAttachment(
  key: string,
  original: Attachment,
  update: (entry: Attachment) => Attachment,
) {
  let updated = false;
  useComposerDraftStore.setState((state) => {
    const draft = state.draftsByThreadKey[key];
    if (!draft) return state;
    const matches = (entry: Attachment) => entry.id === original.id && entry.file === original.file;
    if (![...draft.images, ...draft.files].some(matches)) return state;
    updated = true;
    const apply = <A extends Attachment>(entry: A): A =>
      matches(entry) ? (update(entry) as A) : entry;
    return {
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: { ...draft, images: draft.images.map(apply), files: draft.files.map(apply) },
      },
    };
  });
  return updated;
}

export async function adoptRecoveredAttachment(
  attachment: ComposerFileAttachment,
  file: File,
  resolveTarget: () => ComposerThreadTarget | undefined,
) {
  const retention = await draftAttachmentBytes.save(attachment.id, file);
  const target = resolveTarget();
  const key =
    target === undefined ? null : resolveComposerDraftKey(useComposerDraftStore.getState(), target);
  const entry =
    key === null
      ? undefined
      : useComposerDraftStore
          .getState()
          .draftsByThreadKey[key]?.files.find((item) => item.id === attachment.id);
  if (
    key === null ||
    !entry ||
    entry.file !== null ||
    entry.uploadEnvironmentId !== attachment.uploadEnvironmentId ||
    entry.uploadedAttachmentId !== attachment.uploadedAttachmentId
  )
    return { retention, adopted: false };
  const byteState =
    retention === "cached" && flushComposerDraftPersistence()
      ? ("cached" as const)
      : ("session-only" as const);
  const adopted = updateAttachment(key, attachment, (item) => ({ ...item, file, byteState }));
  return { retention: byteState, adopted };
}

export async function adoptCapturedImage(
  target: ComposerThreadTarget,
  image: Omit<ComposerImageAttachment, "previewUrl" | "file"> & { file: File },
): Promise<"cached" | "rejected" | "not-saved"> {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  if (key === null) return "rejected";
  const original = store.draftsByThreadKey[key]?.images.find((item) => item.id === image.id);
  if (!original || original.file === null) {
    const attachment = {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
      byteState: "saving" as const,
    };
    if (original) {
      if (!updateAttachment(key, original, () => attachment)) {
        URL.revokeObjectURL(attachment.previewUrl);
        return "not-saved";
      }
      if (original.previewUrl.startsWith("blob:")) URL.revokeObjectURL(original.previewUrl);
    } else if (!store.addImage(target, attachment)) {
      URL.revokeObjectURL(attachment.previewUrl);
      return "rejected";
    }
  } else if (canRetryDraftAttachment(original)) {
    updateAttachment(key, original, (entry) => ({ ...entry, byteState: "saving" }));
  }
  await hydrateComposerDraftAttachments(target);
  return useComposerDraftStore
    .getState()
    .draftsByThreadKey[key]?.images.find((item) => item.id === image.id)?.byteState === "cached"
    ? "cached"
    : "not-saved";
}

export async function hydrateComposerDraftAttachments(target: ComposerThreadTarget): Promise<void> {
  const key = resolveComposerDraftKey(useComposerDraftStore.getState(), target);
  if (key === null) return;
  const pending = hydrations.get(key);
  if (pending) return pending;
  const initial = useComposerDraftStore.getState().draftsByThreadKey[key];
  if (!initial || ![...initial.images, ...initial.files].some(draftAttachmentNeedsHydration))
    return;
  const work = (async () => {
    while (true) {
      const draft = useComposerDraftStore.getState().draftsByThreadKey[key];
      if (!draft) {
        hydrations.delete(key);
        return;
      }
      const attachments = [...draft.images, ...draft.files].filter(draftAttachmentNeedsHydration);
      if (attachments.length === 0) {
        hydrations.delete(key);
        return;
      }
      const restored = await Promise.all(
        attachments.map(async (attachment) => {
          let file: File | null;
          try {
            file = attachment.file ?? (await draftAttachmentBytes.load(attachment.id));
          } catch {
            updateAttachment(key, attachment, (entry) => ({
              ...entry,
              byteState: "restore-failed",
            }));
            return null;
          }
          if (!file) {
            updateAttachment(key, attachment, (entry) => ({ ...entry, byteState: "missing" }));
            return null;
          }
          const retention =
            attachment.file === null
              ? "cached"
              : await draftAttachmentBytes.save(attachment.id, file);
          return { attachment, file, retention };
        }),
      );
      const durable =
        restored.some((result) => result?.retention === "cached") &&
        flushComposerDraftPersistence();
      for (const result of restored) {
        if (!result) continue;
        const byteState = result.retention === "cached" && durable ? "cached" : "session-only";
        updateAttachment(key, result.attachment, (entry) => {
          const updated = { ...entry, file: result.file, byteState } satisfies Attachment;
          if (updated.type === "image") {
            if (!updated.previewUrl || updated.legacyDataUrl)
              updated.previewUrl = URL.createObjectURL(result.file);
            if (byteState === "cached") delete updated.legacyDataUrl;
          }
          return updated;
        });
      }
    }
  })().catch((error: unknown) => {
    hydrations.delete(key);
    throw error;
  });
  hydrations.set(key, work);
  return work;
}

export async function retryComposerDraftAttachments(
  target: ComposerThreadTarget,
  ids?: ReadonlyArray<string>,
): Promise<void> {
  const key = resolveComposerDraftKey(useComposerDraftStore.getState(), target);
  if (key === null) return;
  useComposerDraftStore.setState((state) => {
    const draft = state.draftsByThreadKey[key];
    if (!draft) return state;
    const retry = <A extends Attachment>(entry: A): A =>
      canRetryDraftAttachment(entry) && (ids === undefined || ids.includes(entry.id))
        ? { ...entry, byteState: entry.file ? "saving" : "hydrating" }
        : entry;
    return {
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: {
          ...draft,
          images: draft.images.map(retry),
          files: draft.files.map(retry),
        },
      },
    };
  });
  await hydrateComposerDraftAttachments(target);
}

export function initializeComposerDraftAttachments(): void {
  draftAttachmentBytes.start({
    live: () =>
      new Set(
        Object.values(useComposerDraftStore.getState().draftsByThreadKey).flatMap((draft) =>
          [...draft.images, ...draft.files].map((item) => item.id),
        ),
      ),
    persisted: readPersistedDraftAttachmentIds,
  });
}
