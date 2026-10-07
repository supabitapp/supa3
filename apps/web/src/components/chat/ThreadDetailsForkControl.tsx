import type { RunId, ThreadId } from "@supacode/contracts";
import { GitForkIcon } from "lucide-react";
import { useState } from "react";

import { useShortcutLabel } from "../../hooks/useShortcutLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

export function ThreadDetailsForkControl(props: {
  source: { readonly sourceThreadId: ThreadId; readonly runId: RunId };
  disabled: boolean;
  onForkFromRun: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const shortcut = useShortcutLabel("thread.fork");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            disabled={props.disabled || busy}
            onClick={() => {
              setBusy(true);
              void props.onForkFromRun(props.source).finally(() => setBusy(false));
            }}
          />
        }
      >
        <GitForkIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        {busy ? "Forking thread…" : "Fork thread"}
      </TooltipTrigger>
      <TooltipPopup shortcut={shortcut}>Fork thread</TooltipPopup>
    </Tooltip>
  );
}
