import { memo, useEffect, useState } from "react";
import { userInputCountdown } from "@supacode/client-runtime/user-input-countdown";
import { cn } from "~/lib/utils";

export const QuestionAutoDismissTimer = memo(function QuestionAutoDismissTimer({
  deadline,
}: {
  deadline: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
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
  const urgent = countdown.state === "warning" || countdown.state === "closing";
  return (
    <div className="px-3.5 pb-1.5">
      <span
        role="timer"
        aria-live="off"
        aria-label={countdown.label}
        className={cn(
          "text-xs tabular-nums text-secondary-label",
          urgent && "text-warning-foreground",
        )}
      >
        {countdown.text}
      </span>
      <span className="sr-only" role="status">
        {urgent ? "This question will close without an answer soon." : ""}
      </span>
    </div>
  );
});
