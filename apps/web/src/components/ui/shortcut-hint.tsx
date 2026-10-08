import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useLayoutEffect, useState, type RefObject } from "react";

import { Kbd } from "~/components/ui/kbd";
import { useShortcutHintsVisible } from "~/shortcutModifierState";

export function ShortcutHint({
  anchorRef,
  shortcut,
  side,
  align,
  sideOffset,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  shortcut: string;
  side?: TooltipPrimitive.Positioner.Props["side"];
  align?: TooltipPrimitive.Positioner.Props["align"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
}) {
  const visible = useShortcutHintsVisible();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const trigger = anchorRef.current;
    if (!visible || !trigger) {
      setAnchor(null);
      return;
    }
    const updateAnchor = () => {
      const disabled =
        trigger.matches(":disabled, [aria-disabled='true']") ||
        trigger.querySelector(":disabled, [aria-disabled='true']");
      setAnchor(disabled ? null : trigger);
    };
    updateAnchor();
    const observer = new MutationObserver(updateAnchor);
    observer.observe(trigger, {
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [anchorRef, visible]);

  if (!visible || !anchor) return null;

  return (
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root open disableHoverablePopup>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            anchor={anchor}
            side={side}
            align={align}
            sideOffset={sideOffset}
            className="pointer-events-none z-[140] data-[anchor-hidden]:hidden"
          >
            <TooltipPrimitive.Popup
              aria-hidden
              data-slot="shortcut-hint"
              className="flex rounded-md border bg-popover shadow-sm"
            >
              <Kbd variant="hint">{shortcut}</Kbd>
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
