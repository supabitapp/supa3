import { Clock3Icon } from "lucide-react";
import { useState } from "react";

import type { ThreadCreation } from "../../state/threadCreationStorage";
import { cancelThreadCreation, useThreadCreationReason } from "../../state/threadCreationQueue";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

export function ThreadCreationControl(props: { entry: ThreadCreation; onEdit: () => void }) {
  const reason = useThreadCreationReason(props.entry.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore(edit: boolean) {
    setBusy(true);
    setError(null);
    try {
      await cancelThreadCreation(props.entry);
      if (edit) props.onEdit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the waiting task.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ComposerBanner.Drawer open>
      <ComposerBanner.Root>
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <Clock3Icon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="min-w-0">
              <span className="block">{reason}</span>
              <span className="block truncate text-muted-foreground">{props.entry.prompt}</span>
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void restore(true);
              }}
            >
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void restore(false);
              }}
            >
              Cancel
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          Starts automatically while this client is running. Choose a machine in the composer to
          start there.
        </p>
        {error ? (
          <p role="alert" className="px-2 pb-2 text-destructive">
            {error}
          </p>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Drawer>
  );
}
