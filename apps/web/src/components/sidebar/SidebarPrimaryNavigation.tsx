/**
 * The sidebar's top rows: start a thread, search through the command palette,
 * and open Automations. Both the default and the legacy sidebar render it.
 */
import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { CalendarClockIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useStartNewThreadInCurrentProject } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

function withShortcut(label: string, shortcut: string | null) {
  return shortcut ? `${label} (${shortcut})` : null;
}

export function SidebarPrimaryNavigation({ projectGroupCount }: { projectGroupCount: number }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const startNewThreadInCurrentProject = useStartNewThreadInCurrentProject();
  const automationsActive = useLocation({
    select: (location) => location.pathname === "/automations",
  });
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  // The sidebar is offcanvas, so its built-in tooltips (shown only when
  // collapsed) never appear; these show on hover instead, except on touch.
  const withTooltip = (children: ReactNode) =>
    children ? { tooltip: { children, hidden: isMobile } } : {};

  const newThreadShortcut = shortcutLabelForCommand(keybindings, "chat.newLocal");
  const handleNewThread = () => {
    closeMobileSidebar();
    void startNewThreadInCurrentProject();
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          disabled={projectGroupCount === 0}
          onClick={handleNewThread}
          {...withTooltip(withShortcut("New thread", newThreadShortcut) ?? "New thread")}
        >
          <SquarePenIcon />
          <span>New thread</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          // The palette is a dialog over the whole app; on narrow screens the
          // sidebar sheet closes first so the two never stack.
          onClick={() => {
            closeMobileSidebar();
            openCommandPalette();
          }}
          {...withTooltip(
            withShortcut("Search", shortcutLabelForCommand(keybindings, "commandPalette.toggle")),
          )}
        >
          <SearchIcon />
          <span>Search</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={automationsActive}
          render={<Link to="/automations" onClick={closeMobileSidebar} />}
          {...withTooltip(
            withShortcut("Automations", shortcutLabelForCommand(keybindings, "automations.open")),
          )}
        >
          <CalendarClockIcon />
          <span>Automations</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
