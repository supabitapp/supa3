import { scopeThreadRef, scopedThreadKey } from "@supacode/client-runtime/environment";
import { CommandId, type EnvironmentId, type ThreadId, type ProjectId } from "@supacode/contracts";
import { Clock3Icon, PencilIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@supacode/shared/composerContextReferences";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";

import { randomUUID, newThreadId } from "../../lib/utils";
import {
  DraftId,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useThreadOutbox, webThreadOutbox, type PendingThreadTurn } from "../../state/threadOutbox";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ComposerBanner } from "./ComposerBanner";

export function ThreadOutboxControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
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
  const [editing, setEditing] = useState<PendingThreadTurn | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!editing) return;
    const timer = setInterval(() => {
      void webThreadOutbox.pause(editing.id, true).catch(console.error);
    }, 20_000);
    return () => {
      clearInterval(timer);
      void webThreadOutbox.pause(editing.id, false).catch(console.error);
    };
  }, [editing]);

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

  async function save(entry: PendingThreadTurn, message: string) {
    const text = ensureInlineContextReferences(
      message.trim(),
      collectComposerContextReferences(entry.payload.input.message.text),
    );
    const threadId =
      entry.status === "failed" && entry.payload.input.bootstrap?.createThread
        ? newThreadId()
        : entry.payload.input.threadId;
    const changed = await webThreadOutbox.edit(
      entry.id,
      {
        ...entry.payload,
        input: {
          ...entry.payload.input,
          threadId,
          commandId: CommandId.make(randomUUID()),
          message: { ...entry.payload.input.message, text },
        },
      },
      scopedThreadKey(scopeThreadRef(entry.payload.environmentId, threadId)),
    );
    if (!changed)
      throw new Error("Delivery has already started. Reconnect to confirm the message.");
    if (threadId !== entry.payload.input.threadId && entry.payload.draftId) {
      const draftId = DraftId.make(entry.payload.draftId);
      const draft = useComposerDraftStore.getState().getDraftSession(draftId);
      if (draft) restoreFailedBackgroundDraftThread(draftId, draft, threadId);
      void navigate({ to: "/draft/$draftId", params: { draftId } });
    }
    setEditing(null);
  }

  return (
    <ComposerBanner.Drawer open={pending.length > 0}>
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
            return (
              <div key={entry.id}>
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
                      {entry.status === "failed"
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
                    {entry.status === "failed" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          void act(() => save(entry, entry.payload.input.message.text));
                        }}
                      >
                        Retry
                      </Button>
                    ) : null}
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Edit pending message"
                      disabled={busy || !canChange || editing !== null}
                      onClick={() => {
                        void act(async () => {
                          if (!(await webThreadOutbox.pause(entry.id, true)))
                            throw new Error("Delivery has already started.");
                          setText(
                            replaceComposerContextReferences(
                              entry.payload.input.message.text,
                              () => "",
                            ).trim(),
                          );
                          setEditing(entry);
                        });
                      }}
                    >
                      <PencilIcon />
                    </Button>
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
                            const draft = useComposerDraftStore.getState().getDraftSession(draftId);
                            if (draft)
                              restoreFailedBackgroundDraftThread(
                                draftId,
                                draft,
                                entry.status === "failed" ? newThreadId() : draft.threadId,
                              );
                            void navigate({ to: "/draft/$draftId", params: { draftId } });
                          }
                          if (editing?.id === entry.id) setEditing(null);
                        });
                      }}
                    >
                      <XIcon />
                    </Button>
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
                {editing?.id === entry.id ? (
                  <div className="flex flex-col gap-2 p-2">
                    <Textarea
                      aria-label="Pending message"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        Cancel editing
                      </Button>
                      <Button
                        size="xs"
                        disabled={
                          busy ||
                          (text.trim().length === 0 &&
                            entry.payload.localAttachments.length === 0 &&
                            entry.payload.input.message.attachments.length === 0)
                        }
                        onClick={() => {
                          void act(() => save(entry, text));
                        }}
                      >
                        Save message
                      </Button>
                    </div>
                  </div>
                ) : null}
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
