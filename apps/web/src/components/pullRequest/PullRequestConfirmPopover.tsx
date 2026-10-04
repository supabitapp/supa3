import type { ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Popover,
  PopoverClose,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
} from "../ui/popover";

export function PullRequestConfirmPopover({
  open,
  anchor,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  width = "sm",
  onConfirm,
  children,
}: {
  open: boolean;
  anchor: Element | null;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  destructive?: boolean;
  pending?: boolean;
  width?: "sm" | "md";
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Popover
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <PopoverPopup anchor={anchor} side="bottom" align="end" width={width}>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <PopoverTitle>{title}</PopoverTitle>
            <PopoverDescription>{description}</PopoverDescription>
          </div>
          {children}
          <div className="flex justify-end gap-2">
            <PopoverClose render={<Button variant="outline" size="xs" />} disabled={pending}>
              Cancel
            </PopoverClose>
            <Button
              size="xs"
              variant={destructive ? "destructive" : "default"}
              disabled={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
