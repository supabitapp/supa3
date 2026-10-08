import type { ServerUpdateState } from "@supacode/client-runtime/state/server";
import { CircleAlertIcon, DownloadIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_TEXT_CLASS,
} from "./threadDetailsPanelStyles";

export interface ThreadDetailsUpdateNotice {
  readonly status: ServerUpdateState["status"];
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly onDismiss?: () => void;
}

export function ThreadDetailsServerUpdate({ notice }: { notice: ThreadDetailsUpdateNotice }) {
  const { status, title, description, actions, onDismiss } = notice;
  const Icon = status === "failed" ? CircleAlertIcon : DownloadIcon;

  return (
    <ThreadDetailsSection
      headingId="thread-details-server-update-heading"
      title="Server update"
      showHeading={false}
    >
      <div
        className="px-2"
        role={status === "failed" ? "alert" : status === "running" ? "status" : undefined}
      >
        <div className="flex min-h-7 items-center gap-2 pointer-coarse:min-h-11">
          {status === "running" ? (
            <Spinner aria-hidden size="md" tone="muted" />
          ) : (
            <Icon
              aria-hidden
              className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, status === "failed" && "text-error")}
            />
          )}
          <div className={cn("min-w-0 flex-1", THREAD_DETAILS_PANEL_TEXT_CLASS)}>{title}</div>
          {onDismiss ? (
            <ThreadDetailsControl
              part="icon"
              tone="muted"
              aria-label="Dismiss update notice"
              onClick={onDismiss}
            >
              <XIcon aria-hidden />
            </ThreadDetailsControl>
          ) : null}
        </div>
        {description || actions ? (
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1 pl-6 pointer-coarse:min-h-11">
            {description ? (
              <div className="min-w-0 flex-1 basis-28 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {description}
              </div>
            ) : null}
            {actions ? <div className="ml-auto flex shrink-0 items-center">{actions}</div> : null}
          </div>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
