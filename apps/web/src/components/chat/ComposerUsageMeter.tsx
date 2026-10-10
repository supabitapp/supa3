import type { ServerProvider, ServerProviderUsageWindow } from "@supacode/contracts";
import { formatResetsIn, headlineUsageWindows } from "@supacode/shared/usageLimits";
import { memo } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usageFillColor } from "./ContextWindowMeter.logic";

export const ComposerUsageMeter = memo(function ComposerUsageMeter({
  provider,
}: {
  readonly provider: ServerProvider | null;
}) {
  const windows = headlineUsageWindows(provider);
  if (windows.length === 0) return null;
  return (
    <div className="hidden items-center gap-4 px-4 pt-2 text-xs tabular-nums transition-[opacity,visibility] duration-150 ease-out peer-has-data-[chat-composer-resting]/composer-shell:invisible peer-has-data-[chat-composer-resting]/composer-shell:opacity-0 motion-reduce:transition-none sm:flex">
      {windows.map(({ label, window }) => (
        <UsageWindowMeter key={window.id} label={label} window={window} />
      ))}
    </div>
  );
});

function UsageWindowMeter({
  label,
  window,
}: {
  readonly label: string;
  readonly window: ServerProviderUsageWindow;
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
            className="flex cursor-default items-center gap-1.5"
          />
        }
      >
        <span className="text-muted-foreground/70">{label}</span>
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
