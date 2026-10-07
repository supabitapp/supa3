import { scopeThreadRef, scopedThreadKey } from "@supacode/client-runtime/environment";
import type { EnvironmentId, ThreadId, ProjectId } from "@supacode/contracts";
import { Clock3Icon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { replaceComposerContextReferences } from "@supacode/shared/composerContextReferences";

import { newThreadId } from "../../lib/utils";
import {
  DraftId,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  useThreadOutbox,
  webThreadOutbox,
  replaceThreadOutboxTurn,
  type PendingThreadTurn,
} from "../../state/threadOutbox";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { useThreadOutboxVisibility } from "./useThreadOutboxVisibility";

export function ThreadOutboxControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly editingMessageId: string | null;
  readonly onEditMessage: (entry: PendingThreadTurn) => Promise<void>;
  readonly onCancelEdit: () => void;
}) {
  const entries = useThreadOutbox();
  const scope = scopedThreadKey(scopeThreadRef(props.environmentId, props.threadId));
  const pending = entries.filter(
    (entry) =>
      (entry.scope === scope ||
        (entry.payload.environmentId === props.environmentId &&
          props.projectId !== undefined &&
          entry.payload.input.bootstrap?.createThread?.projectId === props.projectId)) &&
      entry.status !== "delivered",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const open = useThreadOutboxVisibility(
    scope,
    pending.length > 0,
    props.editingMessageId !== null ||
      pending.some((entry) => entry.status === "failed" || entry.error !== null),
  );

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the pending message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ComposerBanner.Drawer open={open}>
      <ComposerBanner.Root>
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <Clock3Icon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            {pending.length} pending {pending.length === 1 ? "message" : "messages"}
          </ComposerBanner.Content>
        </ComposerBanner.Row>
        <div className="max-h-56 overflow-y-auto">
          {pending.map((entry) => {
            const canChange = !entry.attempted || entry.status === "failed";
            const isEditing = props.editingMessageId === entry.id;
            return (
              <div
                key={entry.id}
                aria-current={isEditing ? "true" : undefined}
                className={isEditing ? "rounded-md bg-accent text-accent-foreground" : undefined}
              >
                <ComposerBanner.Row>
                  <ComposerBanner.Icon>
                    <Clock3Icon />
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content>
                    <span className="block truncate">
                      {replaceComposerContextReferences(
                        entry.payload.input.message.text,
                        (reference) => reference.label,
                      ) || "Attachment"}
                    </span>
                    <span className="block text-muted-foreground">
                      {isEditing
                        ? "Editing"
                        : entry.status === "failed"
                          ? entry.error
                          : webThreadOutbox.isSending(entry.id)
                            ? "Sending…"
                            : entry.attempted
                              ? "Waiting to confirm delivery"
                              : "Waiting to send"}
                    </span>
                    {entry.payload.localAttachments.length > 0 ? (
                      <span className="block truncate text-muted-foreground">
                        {entry.payload.localAttachments
                          .map((attachment) => attachment.name)
                          .join(", ")}
                      </span>
                    ) : null}
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {entry.status === "failed" && !isEditing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          void act(async () => {
                            const draftId = await replaceThreadOutboxTurn(entry, entry.payload);
                            if (draftId)
                              void navigate({ to: "/draft/$draftId", params: { draftId } });
                          });
                        }}
                      >
                        Retry
                      </Button>
                    ) : null}
                    {isEditing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Cancel editing pending message"
                        disabled={busy}
                        onClick={() => props.onCancelEdit()}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Edit pending message"
                        disabled={busy || !canChange || props.editingMessageId !== null}
                        onClick={() => {
                          void act(() => props.onEditMessage(entry));
                        }}
                      >
                        <PencilIcon />
                      </Button>
                    )}
                    {!isEditing ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Cancel pending message"
                        disabled={busy || !canChange}
                        onClick={() => {
                          void act(async () => {
                            if (!(await webThreadOutbox.cancel(entry.id)))
                              throw new Error("Delivery has already started.");
                            if (entry.payload.draftId) {
                              const draftId = DraftId.make(entry.payload.draftId);
                              const draft = useComposerDraftStore
                                .getState()
                                .getDraftSession(draftId);
                              if (draft)
                                restoreFailedBackgroundDraftThread(
                                  draftId,
                                  draft,
                                  entry.status === "failed" ? newThreadId() : draft.threadId,
                                );
                              void navigate({ to: "/draft/$draftId", params: { draftId } });
                            }
                          });
                        }}
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              </div>
            );
          })}
        </div>
        {error ? (
          <p role="alert" className="px-2 text-destructive">
            {error}
          </p>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Drawer>
  );
}
