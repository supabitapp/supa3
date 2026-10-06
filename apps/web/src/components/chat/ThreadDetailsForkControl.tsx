import { canForkProjectedAssistantItem } from "@supacode/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  RunId,
  ThreadId,
} from "@supacode/contracts";
import { GitForkIcon } from "lucide-react";
import { useState } from "react";

import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

export function ThreadDetailsForkControl(props: {
  environmentId: EnvironmentId;
  projectedItem: OrchestrationV2ProjectedTurnItem;
  disabled: boolean;
  onForkFromRun: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;
  if (!canFork || runId === null) return null;

  return (
    <ThreadDetailsControl
      disabled={props.disabled || busy}
      onClick={() => {
        setBusy(true);
        void props
          .onForkFromRun({ sourceThreadId: props.projectedItem.sourceThreadId, runId })
          .finally(() => setBusy(false));
      }}
    >
      <GitForkIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      {busy ? "Forking thread…" : "Fork thread"}
    </ThreadDetailsControl>
  );
}
