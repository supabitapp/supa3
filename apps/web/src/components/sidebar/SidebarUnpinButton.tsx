import { PinIcon, PinOffIcon } from "lucide-react";

import { useInlineConfirm } from "~/hooks/useInlineConfirm";
import { useClientSettings } from "~/hooks/useSettings";

import { InlineConfirmIcon, InlineConfirmTooltip } from "../InlineConfirm";

export function SidebarUnpinButton({ onUnpin }: { onUnpin: () => void }) {
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const confirm = useInlineConfirm<"unpin">();
  const armed = confirm.armed === "unpin";
  const target = confirmThreadUnpin ? confirm.bind("unpin", onUnpin) : { onClick: onUnpin };
  return (
    <InlineConfirmTooltip
      armed={armed}
      required={confirmThreadUnpin}
      tip="Unpin thread"
      armedTip="Click again to unpin"
      render={
        <button
          type="button"
          aria-label={armed ? "Confirm unpin" : "Unpin thread"}
          {...target}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            target.onClick(event);
          }}
          className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3"
        />
      }
    >
      <InlineConfirmIcon armed={armed}>
        {/* Pin marks the pinned state at rest; hover and focus swap in pin-off so the
            icon reads as the action the button performs. */}
        <PinIcon
          aria-hidden
          className="shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
        />
        <PinOffIcon
          aria-hidden
          className="hidden shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
        />
      </InlineConfirmIcon>
    </InlineConfirmTooltip>
  );
}
