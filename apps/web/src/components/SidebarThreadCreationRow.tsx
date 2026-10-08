import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Clock3Icon } from "lucide-react";

import { DraftId } from "../composerDraftStore";
import type { ThreadCreation } from "../state/threadCreationStorage";
import { cn } from "../lib/utils";

export function SidebarThreadCreationRow(props: {
  entry: ThreadCreation;
  active?: boolean;
  onNavigate?: (draftId: DraftId) => unknown;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = props.active ?? pathname === `/draft/${props.entry.id}`;
  return (
    <li className="list-none">
      <button
        type="button"
        data-testid="sidebar-waiting-thread-row"
        aria-label={`${props.entry.payload.input.bootstrap?.createThread?.title}, Waiting for a machine`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-12 w-full cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={() =>
          props.onNavigate
            ? props.onNavigate(DraftId.make(props.entry.id))
            : void navigate({ to: "/draft/$draftId", params: { draftId: props.entry.id } })
        }
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <Clock3Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {props.entry.payload.input.bootstrap?.createThread?.title}
          </span>
        </span>
        <span className="w-full truncate text-xs text-secondary-label">Waiting for a machine</span>
      </button>
    </li>
  );
}
