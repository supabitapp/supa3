import { CheckIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useInlineConfirm } from "~/hooks/useInlineConfirm";
import { cn } from "~/lib/utils";

import { Button, type ButtonSize, type ButtonVariant } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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
    const measure = () =>
      setWidths({ idle: layoutWidth(idleLabel), confirm: layoutWidth(confirmLabel) });
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

export function InlineConfirmButton({
  size,
  variant,
  disabled,
  icon,
  label,
  confirmLabel,
  tooltip,
  confirmTooltip,
  onConfirm,
}: {
  readonly size: ButtonSize;
  readonly variant: ButtonVariant;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly confirmLabel: string;
  readonly tooltip: ReactNode;
  readonly confirmTooltip: ReactNode;
  readonly onConfirm: () => void;
}) {
  const confirm = useInlineConfirm<"confirm">();
  const armed = confirm.armed === "confirm";
  return (
    <Tooltip>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <Button
            type="button"
            size={size}
            variant={variant}
            disabled={disabled}
            {...confirm.bind("confirm", onConfirm)}
            aria-label={icon === undefined ? undefined : armed ? confirmLabel : label}
          >
            {icon === undefined ? (
              <InlineConfirmLabel armed={armed} idle={label} confirm={confirmLabel} />
            ) : (
              <InlineConfirmIcon armed={armed}>{icon}</InlineConfirmIcon>
            )}
          </Button>
        }
      />
      <TooltipPopup side="top">{armed ? confirmTooltip : tooltip}</TooltipPopup>
    </Tooltip>
  );
}
