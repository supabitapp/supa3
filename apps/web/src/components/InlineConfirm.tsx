import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

const ICON_SWAP_CLASS =
  "col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-drawer motion-reduce:transition-none";
const ICON_HIDDEN_CLASS = "scale-30 opacity-0 blur-xs";

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
  return (
    <span className="inline-grid justify-items-center">
      <span
        aria-hidden={armed || undefined}
        className={cn(
          "col-start-1 row-start-1",
          armed
            ? "opacity-0 transition-none"
            : "transition-opacity duration-150 ease-out motion-reduce:transition-none",
        )}
      >
        {idle}
      </span>
      {armed ? (
        <span className="col-start-1 row-start-1 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none">
          {confirm}
        </span>
      ) : null}
    </span>
  );
}
