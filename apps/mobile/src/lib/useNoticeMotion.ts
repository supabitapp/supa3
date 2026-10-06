import { useMemo } from "react";
import { Easing, FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { useReducedMotionPreference } from "./useReducedMotionPreference";

export function useNoticeMotion() {
  const reducedMotion = useReducedMotionPreference();
  return useMemo(
    () => ({
      entering: reducedMotion
        ? undefined
        : FadeIn.duration(160)
            .easing(Easing.bezier(0.32, 0.72, 0, 1))
            .reduceMotion(ReduceMotion.Never),
      exiting: reducedMotion
        ? undefined
        : FadeOut.duration(120)
            .easing(Easing.bezier(0.32, 0.72, 0, 1))
            .reduceMotion(ReduceMotion.Never),
    }),
    [reducedMotion],
  );
}
