import type { LegendListRef } from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { GestureResponderEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import type { ThreadListV2ListItem } from "../threads/threadListV2";
import { createSwipeRowActivation } from "./swipe-row-activation";

/** Keeps swipe machinery near the viewport in both the inbox and the history drawer. */
export function useThreadListSwipeActivation(
  listRef: RefObject<LegendListRef | null>,
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void,
) {
  const activation = useMemo(() => createSwipeRowActivation(), []);
  const activateVisibleRows = useCallback(
    (rows: ReadonlyArray<ThreadListV2ListItem>) => {
      const state = listRef.current?.getState();
      if (state === undefined || !(state.end >= 0)) return;
      activation.activate(
        rows.slice(Math.max(0, state.start - 2), state.end + 3).map((row) => row.key),
      );
    },
    [activation, listRef],
  );
  // Accessibility and programmatic scrolls also need to activate their destination rows.
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(activationTimerRef.current), []);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll?.(event);
      clearTimeout(activationTimerRef.current);
      activationTimerRef.current = setTimeout(
        () => activateVisibleRows(listRef.current?.getState().data ?? []),
        200,
      );
    },
    [activateVisibleRows, listRef, onScroll],
  );
  const trackTouches = useCallback(
    (event: GestureResponderEvent, started: boolean) => {
      const { changedTouches, touches } = event.nativeEvent;
      activation.trackTouches(
        started ? changedTouches.map((touch) => String(touch.identifier)) : [],
        touches.map((touch) => String(touch.identifier)),
      );
    },
    [activation],
  );
  return { activation, activateVisibleRows, handleScroll, trackTouches };
}
