import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { isMacPlatform } from "@supacode/shared/keybindings";
import { useLayoutEffect, useState, type RefObject } from "react";

import { Kbd } from "~/components/ui/kbd";
import { useShortcutHintsVisible } from "~/shortcutModifierState";

export function ShortcutHint({
  anchorRef,
  shortcut,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  shortcut: string;
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
      const hidden =
        trigger.closest("[hidden], [inert], [aria-hidden='true']") ||
        getComputedStyle(trigger).visibility !== "visible" ||
        trigger.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false;
      const popupOpen = trigger.hasAttribute("data-popup-open");
      setAnchor(disabled || hidden || popupOpen ? null : trigger);
    };
    updateAnchor();
    const observer = new MutationObserver(updateAnchor);
    observer.observe(trigger, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent, { attributes: true });
    }
    const visibilityEvents = ["pointerover", "pointerout", "focusin", "focusout", "transitionend"];
    for (const event of visibilityEvents) {
      trigger.ownerDocument.addEventListener(event, updateAnchor, true);
    }
    return () => {
      observer.disconnect();
      for (const event of visibilityEvents) {
        trigger.ownerDocument.removeEventListener(event, updateAnchor, true);
      }
    };
  }, [anchorRef, visible]);

  if (!visible || !anchor) return null;

  const remainingKeys = isMacPlatform(navigator.platform)
    ? shortcut.replace("⌘", "")
    : shortcut.replace(/^Ctrl\+/, "");
  const label = (remainingKeys || shortcut).replace(/Enter$/, "↵");

  return (
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root
        open
        disableHoverablePopup
        onOpenChange={(_open, details) => {
          details.cancel();
          details.allowPropagation();
        }}
      >
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            anchor={anchor}
            side="top"
            align="center"
            sideOffset={-4}
            collisionAvoidance={{ side: "flip", align: "shift" }}
            className="pointer-events-none z-[140] data-[anchor-hidden]:hidden"
          >
            <TooltipPrimitive.Popup aria-hidden data-slot="shortcut-hint" className="flex">
              <Kbd variant="hint">{label}</Kbd>
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
