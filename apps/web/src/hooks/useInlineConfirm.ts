import { createInlineConfirm } from "@supacode/client-runtime/inline-confirm";
import { useEffect, useId, useRef, useState } from "react";

const TARGET_ATTRIBUTE = "data-inline-confirm";

type PressEvent = {
  readonly timeStamp: number;
  readonly preventBaseUIHandler?: () => void;
};

export function useInlineConfirm<Key extends string>() {
  const scope = useId();
  const [armed, setArmed] = useState<Key | null>(null);
  const [confirm] = useState(() => createInlineConfirm<Key>(setArmed));
  const detachRefs = useRef(new Map<Key, () => () => void>());

  useEffect(() => () => confirm.disarm(), [confirm]);

  useEffect(() => {
    if (armed === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const repeatedActivation = event.repeat && (event.key === "Enter" || event.key === " ");
      if (event.key !== "Escape" && !repeatedActivation) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") confirm.disarm();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const pressed = target?.closest(`[${TARGET_ATTRIBUTE}]`)?.getAttribute(TARGET_ATTRIBUTE);
      if (pressed !== `${scope}:${armed}`) confirm.disarm();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [armed, confirm, scope]);

  const detachRef = (key: Key) => {
    let ref = detachRefs.current.get(key);
    if (ref === undefined) {
      ref = () => () => confirm.disarm(key);
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
        if (!confirm.press(key, event.timeStamp)) {
          event.preventBaseUIHandler?.();
          return;
        }
        run();
      },
    }),
  };
}
