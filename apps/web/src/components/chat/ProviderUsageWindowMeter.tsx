import type { ServerProviderUsageWindow } from "@supacode/contracts";
import { formatResetsIn } from "@supacode/shared/usageLimits";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usageFillColor } from "./ContextWindowMeter.logic";

export function ProviderUsageWindowMeter({
  label,
  window,
  showLabel = true,
  className,
}: {
  readonly label: string;
  readonly window: ServerProviderUsageWindow;
  readonly showLabel?: boolean;
  readonly className?: string;
}) {
  const usedPercent = Math.round(window.usedPercent);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="meter"
            aria-label={window.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPercent}
            aria-valuetext={`${usedPercent}% used`}
            className={cn("flex cursor-default items-center gap-1.5", className)}
          />
        }
      >
        {showLabel ? <span className="text-muted-foreground/70">{label}</span> : null}
        <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-muted-foreground/24">
          <span
            className="block h-full rounded-full transition-[translate,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{
              translate: `${usedPercent - 100}% 0`,
              backgroundColor: usageFillColor(usedPercent),
            }}
          />
        </span>
        <span className="text-muted-foreground">{usedPercent}%</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {window.label}: {usedPercent}% used
          </span>
          {window.resetsAt ? <WindowReset window={window} resetsAt={window.resetsAt} /> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function WindowReset({
  window,
  resetsAt,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly resetsAt: string;
}) {
  const now = useNowMinuteMs();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const resetsIn = formatResetsIn(window, now);
  return (
    <span className="text-muted-foreground">
      Resets {formatUpcomingTimestamp(resetsAt, timestampFormat, now)}
      {resetsIn ? ` · ${resetsIn}` : ""}
    </span>
  );
}
