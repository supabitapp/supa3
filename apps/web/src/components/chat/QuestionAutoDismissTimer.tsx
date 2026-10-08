import { memo, useEffect, useState } from "react";
import { Clock3Icon, PauseIcon } from "lucide-react";
import { userInputCountdown } from "@supacode/client-runtime/user-input-countdown";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

export const QuestionAutoDismissTimer = memo(function QuestionAutoDismissTimer({
  deadline,
  disabled,
  onChange,
}: {
  deadline: string | null;
  disabled: boolean;
  onChange: (enabled: boolean) => Promise<unknown>;
}) {
  const [now, setNow] = useState(Date.now);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= Date.parse(deadline)) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 1_000);
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [deadline]);
  const countdown = userInputCountdown(deadline, now);
  if (countdown === null) return null;
  const paused = countdown.state === "paused";
  const urgent = countdown.state === "warning" || countdown.state === "closing";
  const Icon = paused ? PauseIcon : Clock3Icon;
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 px-3.5 pb-1.5">
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs text-secondary-label",
          urgent && "text-warning-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span role="timer" aria-live="off" aria-label={countdown.label} className="tabular-nums">
          {countdown.text}
        </span>
      </span>
      <Button
        variant="ghost"
        size="xs"
        disabled={disabled || saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onChange(paused);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Saving…" : paused ? "Restart timer" : "Keep open"}
      </Button>
      <span className="sr-only" role="status">
        {urgent ? "This question will close without an answer soon." : ""}
      </span>
    </div>
  );
});
