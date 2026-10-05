import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useThreadFindScroll, type ThreadFindScrollList } from "./use-thread-find-scroll";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("mobile thread find close restoration", () => {
  it.each([true, false])(
    "retains the original view when closing height changes cancel the first restore frame (follow=%s)",
    async (follow) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => {
        frames.delete(id);
      });
      let scrollOffset = 420;
      let following = follow;
      const endFollowRef = { current: follow };
      const setEndFollow = (value: boolean) => {
        following = value;
        endFollowRef.current = value;
      };
      const list: ThreadFindScrollList = {
        getState: () => ({ scroll: scrollOffset }),
        scrollToIndex: vi.fn(async () => {
          scrollOffset = 12;
        }),
        scrollToEnd: vi.fn(async () => {
          scrollOffset = 1_000;
        }),
        scrollToOffset: vi.fn(async (options) => {
          scrollOffset = options.offset;
        }),
      };
      const listRef = { current: list };
      function Probe(props: { navigationKey: string | null; barHeight: number }) {
        useThreadFindScroll({
          ...props,
          targetIndex: props.navigationKey === null ? -1 : 0,
          listRef,
          endFollowRef,
          setEndFollow,
        });
        return null;
      }
      const render = async (navigationKey: string | null, barHeight: number) => {
        await act(async () => {
          const element = <Probe navigationKey={navigationKey} barHeight={barHeight} />;
          if (renderer) renderer.update(element);
          else renderer = create(element);
        });
      };
      const flushFrames = async () => {
        await act(async () => {
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((callback) => callback(0));
        });
      };
      await render("older-match", 70);
      await flushFrames();
      expect(scrollOffset).toBe(12);
      expect(following).toBe(false);
      await render(null, 70);
      expect(frames.size).toBe(1);
      await render(null, 0);
      expect(frames.size).toBe(1);
      await flushFrames();
      expect(scrollOffset).toBe(follow ? 1_000 : 350);
      expect(following).toBe(follow);
      expect(list.scrollToEnd).toHaveBeenCalledTimes(follow ? 1 : 0);
      expect(list.scrollToOffset).toHaveBeenCalledTimes(follow ? 0 : 1);
    },
  );
});
