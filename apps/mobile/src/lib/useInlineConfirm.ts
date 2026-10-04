import { NavigationContext } from "@react-navigation/native";
import { createInlineConfirm } from "@supacode/client-runtime/inline-confirm";
import { useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState, type GestureResponderEvent } from "react-native";

const ARMED_HINT = "Tap again to confirm";
const touchListeners = new Set<(touch: object) => void>();

export function disarmInlineConfirmsOnTouch(event: GestureResponderEvent) {
  for (const listener of touchListeners) listener(event.nativeEvent);
}

export function useInlineConfirm<Key extends string>() {
  const [armed, setArmed] = useState<Key | null>(null);
  const [confirm] = useState(() => createInlineConfirm<Key>(setArmed));
  const touched = useRef<{ readonly key: Key; readonly touch: object } | null>(null);
  const navigation = useContext(NavigationContext);

  useEffect(() => () => confirm.disarm(), [confirm]);

  useEffect(() => {
    if (armed === null) return;
    AccessibilityInfo.announceForAccessibility(ARMED_HINT);
    const disarm = () => confirm.disarm();
    const onTouch = (touch: object) => {
      if (touched.current?.touch !== touch || touched.current.key !== armed) disarm();
    };
    touchListeners.add(onTouch);
    const removeBlur = navigation?.addListener("blur", disarm);
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") disarm();
    });
    return () => {
      touchListeners.delete(onTouch);
      removeBlur?.();
      appState.remove();
    };
  }, [armed, confirm, navigation]);

  return {
    armed,
    bind: (key: Key, run: () => void) => ({
      accessibilityHint: armed === key ? ARMED_HINT : undefined,
      onTouchStart: (event: GestureResponderEvent) => {
        touched.current = { key, touch: event.nativeEvent };
      },
      onPress: () => {
        if (confirm.press(key, Date.now())) run();
      },
    }),
  };
}
