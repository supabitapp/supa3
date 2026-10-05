/**
 * The heading above the thread list, holding project scope and display options.
 *
 * The scope icon swaps to the project favicon while a project is selected,
 * and the heading names that project, so the list still says what it shows.
 *
 * The scope picker itself is passed in: its combobox state lives with the rest
 * of the sidebar's scope logic. `rowRef` lands on the row so the picker's popup
 * can anchor to its width rather than to its 28px trigger.
 */
import { FolderPlusIcon, ListFilterIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Lands on the row so a popup can anchor to its width. */
  rowRef?: RefObject<HTMLDivElement | null>;
  /** The selected project's name, or null for every project. */
  scopeLabel: string | null;
  /** The project scope combobox, rendered before new project. */
  projectScope: ReactNode;
  onNewProject: () => void;
}

export function SidebarThreadHeader({
  rowRef,
  scopeLabel,
  projectScope,
  onNewProject,
}: SidebarThreadHeaderProps) {
  return (
    <div ref={rowRef} className="flex items-center gap-1 pl-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/80">
        {scopeLabel ?? "Threads"}
      </span>
      {/* Unfilled: the buttons carry their own hover states, and a background
          well reads far louder on themed palettes than on the base ones. */}
      <div className="flex shrink-0 items-center">
        <SidebarDisplayMenu />
        {projectScope}
        <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
          <FolderPlusIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

function SidebarDisplayMenu() {
  const display = useClientSettings((settings) => settings.sidebarThreadDisplay);
  const updateSettings = useUpdateClientSettings();
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label="Sidebar options" />}>
        <ListFilterIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuSub>
          <MenuSubTrigger>
            Show
            <span className="ml-auto text-muted-foreground">
              {display === "compact" ? "Compact Row" : "Cards"}
            </span>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={display}
              onValueChange={(value) => {
                if (value === "cards" || value === "compact") {
                  updateSettings({ sidebarThreadDisplay: value });
                }
              }}
            >
              <MenuRadioItem value="cards">
                <span className="flex items-center justify-between gap-4">
                  Cards <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="compact">
                <span className="flex items-center justify-between gap-4">
                  Compact Row <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Icon button with a tooltip, sized for the header's controls. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
