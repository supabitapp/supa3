import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { userInputCountdown } from "@supacode/client-runtime/user-input-countdown";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function QuestionAutoDismissTimer({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= Date.parse(deadline)) clearInterval(timer);
    };
    const timer = setInterval(tick, 1_000);
    tick();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") tick();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [deadline]);
  const countdown = userInputCountdown(deadline, now);
  if (countdown === null) return null;
  const urgent = countdown.state === "warning" || countdown.state === "closing";
  return (
    <Text
      accessibilityRole="timer"
      accessibilityLabel={countdown.label}
      className={cn(
        "font-sans text-xs tabular-nums text-foreground-secondary",
        urgent && "text-warning-foreground",
      )}
    >
      {countdown.text}
    </Text>
  );
}
