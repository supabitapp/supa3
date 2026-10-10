import type { ServerProvider } from "@supacode/contracts";
import {
  type ComposerUsageMeter as Meter,
  composerUsageMeters,
} from "@supacode/shared/usageLimits";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ComposerUsageMeter = memo(function ComposerUsageMeter(props: {
  readonly provider: ServerProvider | null;
  readonly className?: string;
}) {
  const now = useNowMinuteMs();
  const meters = composerUsageMeters(props.provider, now);
  if (meters.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-4 px-4 text-xs tabular-nums", props.className)}>
      {meters.map((meter) => (
        <UsageMeter key={meter.id} meter={meter} now={now} />
      ))}
    </div>
  );
});

function UsageMeter({ meter, now }: { readonly meter: Meter; readonly now: number }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const resetsAt = meter.resetsAt
    ? formatUpcomingTimestamp(meter.resetsAt, timestampFormat, now)
    : null;
  const summary = `${meter.title}: ${meter.usedPercent}% used`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="flex cursor-default items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <span className="text-muted-foreground/70">{meter.label}</span>
        <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-muted-foreground/24">
          <span
            className="block h-full rounded-full transition-[translate,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{
              translate: `${meter.usedPercent - 100}% 0`,
              backgroundColor:
                meter.usedPercent > 90
                  ? "var(--color-error)"
                  : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
            }}
          />
        </span>
        <span className="text-muted-foreground">{meter.usedPercent}%</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">{summary}</span>
          {meter.resetsIn && resetsAt ? (
            <span className="text-muted-foreground">
              Resets in {meter.resetsIn} · {resetsAt}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
