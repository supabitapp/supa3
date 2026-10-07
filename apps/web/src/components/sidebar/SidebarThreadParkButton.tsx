import {
  threadRuntimeIsActive,
  type ThreadRuntimeSummary,
} from "@supacode/client-runtime/state/models";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, type MouseEvent, type PointerEvent } from "react";

import { useInlineConfirm } from "~/hooks/useInlineConfirm";

import { InlineConfirmIcon, InlineConfirmLabel, InlineConfirmTooltip } from "../InlineConfirm";

export function SidebarThreadParkButton({
  thread,
  shortcut,
  onSettle,
  onStop,
  onPointerDown,
}: {
  readonly thread: { readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null };
  readonly shortcut: string | null;
  readonly onSettle: () => void;
  readonly onStop: () => void;
  readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const isRunning = threadRuntimeIsActive(thread.runtime);
  const stopConfirm = useInlineConfirm<"stop">();
  const { armed, bind, disarm } = stopConfirm;
  const isConfirmingStop = isRunning && armed === "stop";
  useEffect(() => {
    if (!isRunning) disarm();
  }, [disarm, isRunning]);

  const stopConfirmTarget = bind("stop", onStop);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isRunning) {
        stopConfirmTarget.onClick(event);
      } else {
        onSettle();
      }
    },
    [isRunning, onSettle, stopConfirmTarget],
  );

  return (
    <InlineConfirmTooltip
      armed={isConfirmingStop}
      required={isRunning}
      tip="Settle thread"
      armedTip="Click again to stop thread"
      shortcut={shortcut}
      render={
        <button
          type="button"
          aria-label={isConfirmingStop ? "Confirm stop thread" : "Settle thread"}
          {...(isRunning ? stopConfirmTarget : {})}
          onClick={handleClick}
          onPointerDown={(event) => {
            if (isRunning) event.stopPropagation();
            else onPointerDown(event);
          }}
          className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-sm text-muted-foreground/65 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      }
    >
      <InlineConfirmIcon armed={isConfirmingStop}>
        <CheckIcon aria-hidden className="size-3.5" />
      </InlineConfirmIcon>
      <InlineConfirmLabel armed={isConfirmingStop} idle="Settle" confirm="Stop thread" />
    </InlineConfirmTooltip>
  );
}
