import { NavigationContext } from "@react-navigation/native";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { useReducedMotionPreference } from "./useReducedMotionPreference";

function subscribe(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

/** Loading motion only runs while its screen is visible and the app is active. */
export function useForegroundMotion() {
  const reducedMotion = useReducedMotionPreference();
  const navigation = useContext(NavigationContext);
  const subscribeFocus = useCallback(
    (listener: () => void) => {
      const unsubscribeFocus = navigation?.addListener("focus", listener);
      const unsubscribeBlur = navigation?.addListener("blur", listener);
      return () => {
        unsubscribeFocus?.();
        unsubscribeBlur?.();
      };
    },
    [navigation],
  );
  const focused = useSyncExternalStore(subscribeFocus, () => navigation?.isFocused() ?? true);
  const active = useSyncExternalStore(subscribe, () => AppState.currentState === "active");
  return !reducedMotion && focused && active;
}
