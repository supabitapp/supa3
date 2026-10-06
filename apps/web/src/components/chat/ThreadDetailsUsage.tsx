import { CircleGaugeIcon, DollarSignIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  type ContextWindowSnapshot,
  formatContextWindowPercentage,
  formatContextWindowTokens,
} from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadDetailsUsage({
  usage,
  children,
}: {
  usage: ContextWindowSnapshot | null;
  children?: ReactNode;
}) {
  if (!usage && !children) return null;

  const percentage = formatContextWindowPercentage(usage?.usedPercentage ?? null);
  const cost = usage?.cost ? formatContextWindowCost(usage.cost) : null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage"
      showHeading={false}
    >
      {usage ? (
        <dl className="m-0">
          <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
            <CircleGaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <dt className="min-w-0 flex-1 truncate">Context used</dt>
            <Tooltip>
              <TooltipTrigger
                render={
                  <dd
                    tabIndex={0}
                    className={cn(
                      "m-0 flex h-7 min-w-10 shrink-0 items-center justify-end rounded-sm font-normal text-muted-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-foreground/50 pointer-coarse:h-11 pointer-coarse:min-w-11",
                      (usage.usedPercentage ?? 0) > 90 && "text-error",
                    )}
                  />
                }
              >
                {percentage ?? `${formatContextWindowTokens(usage.usedTokens)} tokens`}
              </TooltipTrigger>
              <TooltipPopup side="left">
                <span className="tabular-nums">
                  {formatContextWindowTokens(usage.usedTokens)}
                  {usage.maxTokens != null
                    ? ` / ${formatContextWindowTokens(usage.maxTokens)}`
                    : ""}{" "}
                  tokens
                </span>
              </TooltipPopup>
            </Tooltip>
          </div>
          {cost !== null ? (
            <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
              <DollarSignIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <dt className="min-w-0 flex-1 truncate">Estimated cost</dt>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <dd
                      tabIndex={0}
                      className="m-0 flex h-7 min-w-10 max-w-1/2 shrink-0 items-center justify-end rounded-sm font-normal text-muted-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-foreground/50 pointer-coarse:h-11 pointer-coarse:min-w-11"
                    />
                  }
                >
                  <span className="truncate">{cost}</span>
                </TooltipTrigger>
                <TooltipPopup side="left">{cost}</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </dl>
      ) : null}
      {children}
    </ThreadDetailsSection>
  );
}
