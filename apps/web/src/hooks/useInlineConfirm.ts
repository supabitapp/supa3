import { useEffect, useId, useRef, useState } from "react";

const ARMED_TIMEOUT_MS = 5000;
const CONFIRM_GUARD_MS = 400;
const TARGET_ATTRIBUTE = "data-inline-confirm";

type PressEvent = {
  readonly timeStamp: number;
  readonly preventBaseUIHandler?: () => void;
};

export function useInlineConfirm<Key extends string>() {
  const scope = useId();
  const [armed, setArmed] = useState<Key | null>(null);
  const armedAt = useRef(0);
  const detachRefs = useRef(new Map<Key, () => () => void>());

  useEffect(() => {
    if (armed === null) return;
    const disarm = () => setArmed(null);
    const timeout = window.setTimeout(disarm, ARMED_TIMEOUT_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      const repeatedActivation = event.repeat && (event.key === "Enter" || event.key === " ");
      if (event.key !== "Escape" && !repeatedActivation) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") disarm();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const pressed = target?.closest(`[${TARGET_ATTRIBUTE}]`)?.getAttribute(TARGET_ATTRIBUTE);
      if (pressed !== `${scope}:${armed}`) disarm();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [armed, scope]);

  const press = (key: Key, event: PressEvent, run: () => void) => {
    if (armed !== key) {
      armedAt.current = event.timeStamp;
      setArmed(key);
      return false;
    }
    if (event.timeStamp - armedAt.current < CONFIRM_GUARD_MS) return false;
    setArmed(null);
    run();
    return true;
  };

  const detachRef = (key: Key) => {
    let ref = detachRefs.current.get(key);
    if (ref === undefined) {
      ref = () => () => setArmed((current) => (current === key ? null : current));
      detachRefs.current.set(key, ref);
    }
    return ref;
  };

  return {
    armed,
    bind: (key: Key, run: () => void) => ({
      [TARGET_ATTRIBUTE]: `${scope}:${key}`,
      ref: detachRef(key),
      onClick: (event: PressEvent) => {
        if (!press(key, event, run)) event.preventBaseUIHandler?.();
      },
    }),
  };
}
