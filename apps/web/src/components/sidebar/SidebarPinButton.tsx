import { PinIcon } from "lucide-react";

import { useInlineConfirm } from "~/hooks/useInlineConfirm";
import { useClientSettings } from "~/hooks/useSettings";

import { InlineConfirmIcon, InlineConfirmTooltip } from "../InlineConfirm";

export function SidebarPinButton({
  pinned,
  onPin,
  onUnpin,
}: {
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const confirm = useInlineConfirm<"unpin">();
  const armed = pinned && confirm.armed === "unpin";
  const target =
    pinned && confirmThreadUnpin
      ? confirm.bind("unpin", onUnpin)
      : { onClick: pinned ? onUnpin : onPin };
  const label = pinned ? "Unpin thread" : "Pin thread";
  return (
    <InlineConfirmTooltip
      armed={armed}
      required={pinned && confirmThreadUnpin}
      tip={label}
      armedTip="Click again to unpin"
      render={
        <button
          type="button"
          aria-label={armed ? "Confirm unpin" : label}
          {...target}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            target.onClick(event);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
        />
      }
    >
      <InlineConfirmIcon armed={armed}>
        <PinIcon aria-hidden fill={pinned ? "currentColor" : "none"} />
      </InlineConfirmIcon>
    </InlineConfirmTooltip>
  );
}
