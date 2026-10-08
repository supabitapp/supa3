import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useRender } from "@base-ui/react/use-render";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Kbd } from "~/components/ui/kbd";
import { POPUP_MOTION_CLASS } from "~/components/ui/popup-styles";
import { ShortcutHint } from "~/components/ui/shortcut-hint";
import { cn } from "~/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipTriggerRefContext = createContext<RefObject<HTMLElement | null> | null>(null);
function createTooltipHoverTracker() {
  let current: { trigger: HTMLElement; actionsRef: TooltipActionsRef } | null = null;
  return {
    get: () => current,
    register: (trigger: HTMLElement, actionsRef: TooltipActionsRef) => {
      current = { trigger, actionsRef };
    },
    clear: (actionsRef: TooltipActionsRef) => {
      if (current?.actionsRef === actionsRef) current = null;
    },
  };
}
const TooltipScrollContext = createContext<ReturnType<typeof createTooltipHoverTracker> | null>(
  null,
);

/** Dismisses hovered descendants on real scroll events without rerendering the timeline. */
function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const [hovered] = useState(createTooltipHoverTracker);
  return (
    <TooltipScrollContext value={hovered}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          const tooltip = hovered.get();
          if (!tooltip || tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)) {
            return;
          }
          hovered.clear(tooltip.actionsRef);
          // Base UI also cancels delayed hover opens through this action.
          tooltip.actionsRef.current?.close();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const hovered = use(TooltipScrollContext);
  const triggerRef = useRef<HTMLElement | null>(null);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  useEffect(
    () => () => {
      hovered?.clear(actionsRef);
    },
    [actionsRef, hovered],
  );

  return (
    <TooltipTriggerRefContext value={props.disabled ? null : triggerRef}>
      <TooltipHoverContext value={hovered ? actionsRef : null}>
        <TooltipPrimitive.Root
          {...props}
          actionsRef={actionsRef}
          onOpenChange={(open, details) => {
            props.onOpenChange?.(open, details);
            if (!open && !details.isCanceled) {
              hovered?.clear(actionsRef);
            }
          }}
        />
      </TooltipHoverContext>
    </TooltipTriggerRefContext>
  );
}

function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const hovered = use(TooltipScrollContext);
  const actionsRef = use(TooltipHoverContext);
  const triggerRef = use(TooltipTriggerRefContext);
  return useRender({
    render: <TooltipPrimitive.Trigger {...props} />,
    ref: triggerRef ?? undefined,
    props: {
      "data-slot": "tooltip-trigger",
      onMouseEnter(event: MouseEvent<HTMLElement>) {
        if (actionsRef) hovered?.register(event.currentTarget, actionsRef);
      },
    },
  });
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  shortcut,
  shortcutHint = shortcut,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  /** `code` renders monospace content that breaks anywhere, for paths and commands. */
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  /** The key that runs the same action as the trigger, shown after the content. */
  shortcut?: string | null | undefined;
  shortcutHint?: string | null | undefined;
}) {
  const triggerRef = use(TooltipTriggerRefContext);
  return (
    <>
      {shortcutHint && triggerRef ? (
        <ShortcutHint anchorRef={triggerRef} shortcut={shortcutHint} />
      ) : null}
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          align={align}
          anchor={anchor}
          className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none motion-reduce:transition-none"
          data-slot="tooltip-positioner"
          side={side}
          sideOffset={sideOffset}
        >
          <TooltipPrimitive.Popup
            className={cn(
              "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
              POPUP_MOTION_CLASS,
              variant === "glass"
                ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
                : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
              // One wrap width for prose; code dumps get more room and break anywhere.
              variant === "code"
                ? "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed"
                : "max-w-80 wrap-anywhere whitespace-normal leading-snug",
              className,
            )}
            data-slot="tooltip-popup"
            {...props}
          >
            <TooltipPrimitive.Viewport
              className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
              data-slot="tooltip-viewport"
            >
              {shortcut ? (
                <TooltipShortcutLabel shortcut={shortcut}>{children}</TooltipShortcutLabel>
              ) : (
                children
              )}
            </TooltipPrimitive.Viewport>
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </>
  );
}

/** One tooltip row naming an action, followed by the key that runs it when one is bound. */
function TooltipShortcutLabel({
  children,
  shortcut,
}: {
  children: ReactNode;
  shortcut: string | null;
}) {
  if (!shortcut) return children;
  return (
    <span className="flex items-center justify-between gap-2" data-slot="tooltip-shortcut-label">
      <span className="min-w-0">{children}</span>
      <Kbd variant="raised">{shortcut}</Kbd>
    </span>
  );
}

export {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipScrollDismissArea,
  TooltipShortcutLabel,
};
