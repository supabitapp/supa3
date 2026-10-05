import type { LegendListRef } from "@legendapp/list/react-native";
import { useEffect, useRef, type RefObject } from "react";

export type ThreadFindScrollList = Pick<
  LegendListRef,
  "scrollToEnd" | "scrollToIndex" | "scrollToOffset"
> & {
  readonly getState: () => Pick<ReturnType<LegendListRef["getState"]>, "scroll">;
};

/** Restore recent history after the find bar and its content inset finish closing. */
export function useThreadFindScroll(options: {
  readonly navigationKey: string | null;
  readonly targetIndex: number;
  readonly barHeight: number;
  readonly listRef: RefObject<ThreadFindScrollList | null>;
  readonly endFollowRef: RefObject<boolean>;
  readonly setEndFollow: (follow: boolean) => void;
}) {
  const lastNavigation = useRef<string | null>(null);
  const beforeFind = useRef<{ readonly offset: number; readonly follow: boolean } | null>(null);
  const { navigationKey, targetIndex, barHeight, listRef, endFollowRef, setEndFollow } = options;
  useEffect(() => {
    if (navigationKey === null) {
      lastNavigation.current = null;
      const restore = beforeFind.current;
      if (restore === null) return;
      let cancelled = false;
      setEndFollow(restore.follow);
      const frame = requestAnimationFrame(() => {
        const list = listRef.current;
        if (list === null) return;
        const scrolling = restore.follow
          ? list.scrollToEnd({ animated: false })
          : list.scrollToOffset({ animated: false, offset: restore.offset });
        // A height change can cancel the scheduled frame. Keep its saved view
        // until a scroll actually completes so the next layout can retry it.
        void Promise.resolve(scrolling).then(() => {
          if (!cancelled && beforeFind.current === restore) beforeFind.current = null;
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    const key = `${navigationKey}:${barHeight}`;
    if (targetIndex < 0 || lastNavigation.current === key) return;
    if (beforeFind.current === null) {
      beforeFind.current = {
        offset: (listRef.current?.getState().scroll ?? 0) - barHeight,
        follow: endFollowRef.current,
      };
    }
    setEndFollow(false);
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      if (list === null) return;
      lastNavigation.current = key;
      list.scrollToIndex({
        index: targetIndex,
        animated: false,
        viewPosition: 0,
        viewOffset: barHeight + 12,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationKey, targetIndex, barHeight, listRef, endFollowRef, setEndFollow]);
}
