// @effect-diagnostics globalTimers:off -- React connection status uses display timers outside the Effect runtime.

export const CONNECTION_STATUS_DELAY_MS = 1_500;

export function createConnectionStatusDelay(onChange: (key: string | null) => void) {
  let key: string | null = null;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reset = () => {
    clearTimeout(timer);
    timer = undefined;
    shown = false;
    onChange(null);
  };

  return {
    update(input: { key: string; pending: boolean; active: boolean; immediate: boolean }) {
      if (key !== input.key || !input.pending || !input.active) reset();
      key = input.key;
      if (!input.pending || !input.active || shown) return;
      const show = () => {
        timer = undefined;
        shown = true;
        onChange(key);
      };
      if (input.immediate) {
        clearTimeout(timer);
        show();
      } else if (timer === undefined) {
        timer = setTimeout(show, CONNECTION_STATUS_DELAY_MS);
      }
    },
    pause: reset,
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      shown = false;
    },
  };
}
