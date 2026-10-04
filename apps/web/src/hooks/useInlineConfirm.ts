import { useEffect, useId, useRef, useState } from "react";

const ARMED_TIMEOUT_MS = 5000;
const CONFIRM_GUARD_MS = 400;

export function useInlineConfirm<Key extends string>() {
  const scope = useId();
  const [armed, setArmed] = useState<Key | null>(null);
  const armedAt = useRef(0);

  useEffect(() => {
    if (armed === null) return;
    const disarm = () => setArmed(null);
    const timeout = window.setTimeout(disarm, ARMED_TIMEOUT_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      disarm();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[data-inline-confirm="${CSS.escape(`${scope}:${armed}`)}"]`)) return;
      disarm();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [armed, scope]);

  const press = (
    key: Key,
    event: { readonly detail: number; readonly timeStamp: number },
    run: () => void,
  ) => {
    if (armed !== key) {
      armedAt.current = event.timeStamp;
      setArmed(key);
      return;
    }
    if (event.detail > 1 || event.timeStamp - armedAt.current < CONFIRM_GUARD_MS) return;
    setArmed(null);
    run();
  };

  return {
    armed,
    disarm: () => setArmed(null),
    bind: (key: Key, run: () => void) => ({
      "data-inline-confirm": `${scope}:${key}`,
      onClick: (event: { readonly detail: number; readonly timeStamp: number }) =>
        press(key, event, run),
    }),
  };
}
