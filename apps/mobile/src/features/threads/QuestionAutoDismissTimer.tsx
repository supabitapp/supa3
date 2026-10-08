import { useEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { userInputCountdown } from "@supacode/client-runtime/user-input-countdown";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function QuestionAutoDismissTimer({
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
  const paused = countdown.state === "paused";
  const urgent = countdown.state === "warning" || countdown.state === "closing";
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-3">
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
      <Pressable
        accessibilityRole="button"
        disabled={disabled || saving}
        onPress={async () => {
          setSaving(true);
          try {
            await onChange(paused);
          } finally {
            setSaving(false);
          }
        }}
        className="min-h-11 items-center justify-center px-2 active:opacity-70"
      >
        <Text
          className={cn(
            "font-supacode-medium text-xs text-foreground-secondary",
            (disabled || saving) && "text-foreground-tertiary",
          )}
        >
          {saving ? "Saving…" : paused ? "Restart timer" : "Keep open"}
        </Text>
      </Pressable>
    </View>
  );
}
