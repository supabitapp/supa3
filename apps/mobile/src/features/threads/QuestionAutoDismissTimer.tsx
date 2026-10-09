import { useLayoutEffect, useState } from "react";
import { AppState } from "react-native";
import { userInputCountdown } from "@supacode/client-runtime/user-input-countdown";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

type QuestionAutoDismissCountdown = NonNullable<ReturnType<typeof userInputCountdown>>;

export function useQuestionAutoDismissCountdown(deadline: string | null) {
  const [now, setNow] = useState(Date.now);
  useLayoutEffect(() => {
    if (deadline === null) return;
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
  return userInputCountdown(deadline, now);
}

export function QuestionAutoDismissTimer({
  countdown,
}: {
  countdown: QuestionAutoDismissCountdown;
}) {
  return (
    <Text
      className={cn(
        "shrink font-sans text-xs tabular-nums text-foreground-secondary",
        countdown.state !== "counting" && "text-warning-foreground",
      )}
    >
      {countdown.text}
    </Text>
  );
}
