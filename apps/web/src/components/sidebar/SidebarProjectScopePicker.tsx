import { FolderIcon, ListFilterIcon, SettingsIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  memo,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { useAtomValue } from "@effect/atom-react";

import { usePickerShortcuts } from "../../hooks/usePickerShortcuts";
import {
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  filterSidebarProjectScopeItems,
  reduceSidebarProjectScopeMenuState,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { SidebarUtilityButton } from "./SidebarChrome";

/** The footer's project filter: scopes the thread list to one project. */
export const SidebarProjectScopePicker = memo(function SidebarProjectScopePicker({
  anchor,
  projectGroups,
  scopedProjectGroup,
  onOpenProjectSettings,
}: {
  /** The popup anchors here so it is at least as wide as the footer row. */
  anchor: RefObject<HTMLElement | null>;
  projectGroups: readonly SidebarProjectSnapshot[];
  scopedProjectGroup: SidebarProjectSnapshot | null;
  onOpenProjectSettings: (projectGroup: SidebarProjectSnapshot) => void;
}) {
  const setProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentMachineById = useEnvironmentMachines();
  // {value, label} items let Base UI drive the combobox selection contract
  // while the popup search filters the same collection.
  const projectScopeItems = useMemo(
    () => [
      { value: "all", label: "All projects" },
      ...projectGroups.map((project) => ({
        value: project.projectKey,
        label: project.displayName,
      })),
    ],
    [projectGroups],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const projectGroupByScopeKey = useMemo(
    () => new Map(projectGroups.map((project) => [project.projectKey, project] as const)),
    [projectGroups],
  );
  const selectedProjectScopeItem = useMemo(
    () =>
      projectScopeItems.find((item) => item.value === (scopedProjectGroup?.projectKey ?? "all")) ??
      projectScopeItems[0]!,
    [projectScopeItems, scopedProjectGroup],
  );
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  // Filtering derives from the same React state that controls the input, so
  // the visible query and the visible list can never desync — the peer wiring
  // in DiffPanel and BranchToolbarBranchSelector. "All projects" is the default
  // row, not a searchable entry: it heads the list while the query is empty and
  // drops out while filtering, so it can't outrank a project match under
  // autoHighlight and no-hit queries reach the empty state.
  const filteredProjectScopeItems = useMemo(
    () =>
      filterSidebarProjectScopeItems({
        items: projectScopeItems,
        query: projectScopeMenuState.query,
        matches: (item, query) =>
          projectScopeFilter.contains(item, query, (candidate) => candidate.label),
      }),
    [projectScopeFilter, projectScopeItems, projectScopeMenuState.query],
  );
  const projectScopeJumpItems = useMemo(
    () => filteredProjectScopeItems.filter((item) => item.value !== "all"),
    [filteredProjectScopeItems],
  );
  const projectScopeJumpLabels = usePickerShortcuts({
    picker: "project",
    open: projectScopeMenuState.open,
    items: projectScopeJumpItems,
    keybindings,
    onSelect: (item) => {
      setProjectScopeKey(item.value);
      dispatchProjectScopeMenu({ type: "open-changed", open: false });
    },
  });
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  const handleProjectSettings = useCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      onOpenProjectSettings(projectGroup);
    },
    [onOpenProjectSettings],
  );

  return (
    <Combobox
      items={projectScopeItems}
      filteredItems={filteredProjectScopeItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={projectScopeMenuState.open}
      onOpenChange={(open) => {
        if (open) suppressNextScopeChangeRef.current = false;
        dispatchProjectScopeMenu({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedProjectScopeKeyRef.current = item?.value ?? null;
      }}
      value={selectedProjectScopeItem}
      onValueChange={(item) => {
        if (suppressNextScopeChangeRef.current) {
          suppressNextScopeChangeRef.current = false;
          return;
        }
        if (!item) return;
        setProjectScopeKey(item.value === "all" ? null : item.value);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarUtilityButton
            isActive={scopedProjectGroup !== null}
            label={
              scopedProjectGroup
                ? `Filter threads by project: ${scopedProjectGroup.displayName}`
                : "Filter threads by project"
            }
          />
        }
      >
        {scopedProjectGroup ? (
          // Wrapped so the button's direct-child svg color rule cannot override
          // a project's own icon color.
          <span className="flex shrink-0">
            <ProjectFavicon project={scopedProjectGroup} className="size-4" />
          </span>
        ) : (
          <ListFilterIcon />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        side="top"
        align="start"
        // Anchored to the footer row, not the 32px trigger: the
        // popup opens above the row, is at least as wide as it,
        // and grows to fit project names up to a cap, past which
        // the rows truncate.
        anchor={anchor}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={projectScopeMenuState.query}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
            ) {
              return;
            }
            // Combobox items use virtual focus: keyboard events
            // stay on this input, not on the highlighted option.
            const scopeKey = highlightedProjectScopeKeyRef.current;
            const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
            if (project) handleProjectSettings(event, project);
          }}
          onChange={(event) =>
            dispatchProjectScopeMenu({
              type: "query-changed",
              query: event.target.value,
            })
          }
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof projectScopeItems)[number]) => {
            const project = projectGroupByScopeKey.get(item.value) ?? null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                onContextMenu={(event) => {
                  if (project) handleProjectSettings(event, project);
                }}
              >
                {project ? (
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {project && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={project}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
                {projectScopeJumpLabels.has(item) ? (
                  <Kbd variant="plain" aria-hidden>
                    {projectScopeJumpLabels.get(item)}
                  </Kbd>
                ) : null}
                {project ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.displayName}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      void handleProjectSettings(event, project);
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
