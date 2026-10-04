import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

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
        className={cn("col-start-1 row-start-1", armed && "invisible")}
      >
        {idle}
      </span>
      {armed ? <span className="col-start-1 row-start-1">{confirm}</span> : null}
    </span>
  );
}
