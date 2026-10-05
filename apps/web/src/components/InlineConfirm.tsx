import { CheckIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

const ICON_SWAP_CLASS =
  "col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-drawer motion-reduce:transition-none";
const ICON_HIDDEN_CLASS = "scale-30 opacity-0 blur-xs";
const LABEL_SHOWN_CLASS = "transition-opacity duration-150 ease-out motion-reduce:transition-none";
const LABEL_HIDDEN_CLASS = "opacity-0 transition-none";

export function InlineConfirmIcon({ armed, children }: { armed: boolean; children: ReactNode }) {
  return (
    <span aria-hidden className="inline-grid shrink-0 place-items-center">
      <span className={cn(ICON_SWAP_CLASS, "inline-flex", armed && ICON_HIDDEN_CLASS)}>
        {children}
      </span>
      <span className={cn(ICON_SWAP_CLASS, "inline-flex", !armed && ICON_HIDDEN_CLASS)}>
        <CheckIcon className="size-3.5" />
      </span>
    </span>
  );
}

export function InlineConfirmLabel({
  armed,
  idle,
  confirm,
}: {
  armed: boolean;
  idle: ReactNode;
  confirm: ReactNode;
}) {
  const idleRef = useRef<HTMLSpanElement>(null);
  const confirmRef = useRef<HTMLSpanElement>(null);
  const [widths, setWidths] = useState<{
    readonly idle: number;
    readonly confirm: number;
  } | null>(null);

  useLayoutEffect(() => {
    const idleLabel = idleRef.current;
    const confirmLabel = confirmRef.current;
    if (idleLabel === null || confirmLabel === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const layoutWidth = (element: HTMLElement) =>
      Math.ceil(Number.parseFloat(getComputedStyle(element).width) || 0);
    const measure = () => {
      if (idleLabel.getClientRects().length === 0) return;
      setWidths({ idle: layoutWidth(idleLabel), confirm: layoutWidth(confirmLabel) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(idleLabel);
    observer.observe(confirmLabel);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      className="inline-grid grid-cols-1 overflow-hidden transition-[width] duration-200 ease-in-out motion-reduce:transition-none"
      style={
        widths === null
          ? undefined
          : { width: armed ? Math.max(widths.idle, widths.confirm) : widths.idle }
      }
    >
      <span
        ref={idleRef}
        aria-hidden={armed || undefined}
        className={cn(
          "col-start-1 row-start-1 justify-self-center",
          armed ? LABEL_HIDDEN_CLASS : LABEL_SHOWN_CLASS,
        )}
      >
        {idle}
      </span>
      <span
        ref={confirmRef}
        aria-hidden={!armed || undefined}
        className={cn(
          "col-start-1 row-start-1 justify-self-center",
          armed ? LABEL_SHOWN_CLASS : LABEL_HIDDEN_CLASS,
        )}
      >
        {confirm}
      </span>
    </span>
  );
}
