import { useLayoutEffect, useMemo, useRef } from "react";
import {
  Easing,
  ReduceMotion,
  useSharedValue,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type LayoutAnimationFunction,
} from "react-native-reanimated";

import { useReducedMotionPreference } from "./useReducedMotionPreference";
import { shouldAnimateListChange } from "./listChangeMotion";
import { isKeyboardMotionSuppressed } from "./motionInput";

/** Uses LegendList's recycling guards while animating only visible cells' transforms and opacity. */
export function useListChangeMotion(input: {
  readonly items: ReadonlyArray<{ readonly key: string }>;
  readonly scope: string;
  readonly searching: boolean;
  readonly scrolling: boolean;
  readonly ready: boolean;
  readonly includeEmpty?: boolean;
}) {
  const { items, scope, searching, scrolling, ready, includeEmpty = false } = input;
  const reducedMotion = useReducedMotionPreference();
  const frame = useMemo(() => ({ keys: items.map((item) => item.key), scope }), [items, scope]);
  const previous = useRef<typeof frame | null>(null);
  const enabled = useSharedValue(0);
  useLayoutEffect(() => {
    const animate =
      ready &&
      previous.current !== null &&
      !isKeyboardMotionSuppressed() &&
      shouldAnimateListChange({
        keys: frame.keys,
        scope: frame.scope,
        previousKeys: previous.current.keys,
        previousScope: previous.current.scope,
        searching,
        includeEmpty,
      });
    previous.current = ready ? frame : null;
    enabled.set(animate && !reducedMotion && !scrolling ? 1 : 0);
    if (animate && !reducedMotion && !scrolling) {
      // Newly recycled rows reached by a later scroll must never play an entrance.
      enabled.set(withTiming(0, { duration: 220, reduceMotion: ReduceMotion.Never }));
    }
  }, [enabled, frame, scrolling, searching, reducedMotion, ready, includeEmpty]);

  return useMemo(() => {
    const timing = {
      duration: 180,
      easing: Easing.inOut(Easing.cubic),
      reduceMotion: ReduceMotion.Never,
    };
    const entryTiming = { ...timing, easing: Easing.bezier(0.32, 0.72, 0, 1) };
    const layout: LayoutAnimationFunction = (values) => {
      "worklet";
      const visible =
        values.currentGlobalOriginY + values.currentHeight > 0 &&
        values.currentGlobalOriginY < values.windowHeight &&
        values.targetGlobalOriginY + values.targetHeight > 0 &&
        values.targetGlobalOriginY < values.windowHeight;
      const offset =
        enabled.value > 0 && visible ? values.currentOriginY - values.targetOriginY : 0;
      const offsetX =
        enabled.value > 0 && visible ? values.currentOriginX - values.targetOriginX : 0;
      const geometry = {
        originX: values.targetOriginX,
        originY: values.targetOriginY,
        width: values.targetWidth,
        height: values.targetHeight,
      };
      return {
        initialValues: {
          ...geometry,
          transform: [{ translateX: offsetX }, { translateY: offset }],
        },
        animations: {
          ...geometry,
          transform: [
            { translateX: offsetX === 0 ? 0 : withTiming(0, timing) },
            { translateY: offset === 0 ? 0 : withTiming(0, timing) },
          ],
        },
      };
    };
    const entering = (values: EntryAnimationsValues) => {
      "worklet";
      const animateEntry =
        enabled.value > 0 &&
        values.targetGlobalOriginY + values.targetHeight > 0 &&
        values.targetGlobalOriginY < values.windowHeight;
      return {
        initialValues: {
          opacity: animateEntry ? 0 : 1,
          transform: [{ translateY: animateEntry ? -4 : 0 }],
        },
        animations: {
          opacity: animateEntry ? withTiming(1, entryTiming) : 1,
          transform: [{ translateY: animateEntry ? withTiming(0, entryTiming) : 0 }],
        },
      };
    };
    const exiting = (values: ExitAnimationsValues) => {
      "worklet";
      const animateExit =
        enabled.value > 0 &&
        values.currentGlobalOriginY + values.currentHeight > 0 &&
        values.currentGlobalOriginY < values.windowHeight;
      return {
        initialValues: { opacity: 1 },
        animations: { opacity: animateExit ? withTiming(0, { ...entryTiming, duration: 140 }) : 0 },
      };
    };
    return { layout, entering, exiting };
  }, [enabled]);
}
