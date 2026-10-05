/**
 * The sidebar's top rows: start a thread, search through the command palette,
 * and open Automations. Both the default and the legacy sidebar render it.
 */
import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { CalendarClockIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useStartNewThreadInCurrentProject } from "../../hooks/useHandleNewThread";
import { useLegacySidebarEnabled } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { shouldCreateNewThreadInCurrentProject } from "../Sidebar.logic";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

function withShortcut(label: string, shortcut: string | null) {
  return shortcut ? `${label} (${shortcut})` : null;
}

export function SidebarPrimaryNavigation({ projectGroupCount }: { projectGroupCount: number }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const navigationSize = isMobile ? "default" : "compact";
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
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

  // Mirrors chat.new: the default sidebar asks which project when there is a
  // choice, Shift+click skips the question, and the legacy sidebar never asks.
  // While it asks, the label names only chat.new; chat.newLocal is the
  // Shift+click twin, so it gets its own line rather than standing in.
  const asksForProject = (shiftKey: boolean) =>
    !legacySidebarEnabled && !shouldCreateNewThreadInCurrentProject(shiftKey, projectGroupCount);
  const newThreadShortcut = shortcutLabelForCommand(keybindings, "chat.new");
  const newThreadInProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newLocal");
  const handleNewThread = (event: ReactMouseEvent) => {
    closeMobileSidebar();
    if (asksForProject(event.shiftKey)) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    void startNewThreadInCurrentProject();
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size={navigationSize}
          disabled={projectGroupCount === 0}
          onClick={handleNewThread}
          {...withTooltip(
            asksForProject(false) ? (
              <span className="flex flex-col gap-0.5">
                <span>{withShortcut("New thread", newThreadShortcut) ?? "New thread"}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcut ? ` (${newThreadInProjectShortcut})` : ""}
                </span>
              </span>
            ) : (
              withShortcut("New thread", newThreadShortcut ?? newThreadInProjectShortcut)
            ),
          )}
        >
          <SquarePenIcon />
          <span>New thread</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          size={navigationSize}
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
          size={navigationSize}
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
