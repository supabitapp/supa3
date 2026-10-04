/**
 * The sidebar's top rows: start a thread, search through the command palette,
 * and open Automations. Both the default and the legacy sidebar render it and
 * supply their own new-thread behavior.
 */
import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { CalendarClockIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function NavigationItem({ tooltip, button }: { tooltip: ReactNode; button: ReactElement }) {
  return (
    <SidebarMenuItem>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side="right">{tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
    </SidebarMenuItem>
  );
}

function withShortcut(label: string, shortcut: string | null) {
  return shortcut ? `${label} (${shortcut})` : null;
}

export function SidebarPrimaryNavigation({
  onNewThread,
  newThreadDisabled,
  newThreadTooltip,
}: {
  /** Receives the click so Shift+click can skip the project picker. */
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadTooltip: ReactNode;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const automationsActive = useLocation({
    select: (location) => location.pathname === "/automations",
  });
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <SidebarMenu>
      <NavigationItem
        tooltip={newThreadTooltip}
        button={
          <SidebarMenuButton disabled={newThreadDisabled} onClick={onNewThread}>
            <SquarePenIcon />
            <span>New thread</span>
          </SidebarMenuButton>
        }
      />
      <NavigationItem
        tooltip={withShortcut(
          "Search",
          shortcutLabelForCommand(keybindings, "commandPalette.toggle"),
        )}
        button={
          <SidebarMenuButton
            // The palette is a dialog over the whole app; on narrow screens the
            // sidebar sheet closes first so the two never stack.
            onClick={() => {
              closeMobileSidebar();
              openCommandPalette();
            }}
          >
            <SearchIcon />
            <span>Search</span>
          </SidebarMenuButton>
        }
      />
      <NavigationItem
        tooltip={withShortcut(
          "Automations",
          shortcutLabelForCommand(keybindings, "automations.open"),
        )}
        button={
          <SidebarMenuButton
            isActive={automationsActive}
            aria-current={automationsActive ? "page" : undefined}
            render={<Link to="/automations" onClick={closeMobileSidebar} />}
          >
            <CalendarClockIcon />
            <span>Automations</span>
          </SidebarMenuButton>
        }
      />
    </SidebarMenu>
  );
}
