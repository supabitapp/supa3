import { ThreadDetailsComboboxControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@supacode/contracts";
import { ScaleIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { memo, useId, useMemo, useState } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import { useShortcutLabel } from "../hooks/useShortcutLabel";
import { usePickerShortcuts } from "../hooks/usePickerShortcuts";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Combobox,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxList,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxStatus,
  useComboboxFilter,
} from "./ui/combobox";
import { Kbd } from "./ui/kbd";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  autoEnvironmentDisabledReason?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  displayMode?: "toolbar" | "panel";
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  autoEnvironmentDisabledReason,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  displayMode = "toolbar",
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const hostShortcut = useShortcutLabel(displayMode === "toolbar" ? "composer.host" : null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const disabledReasonId = useId();
  const hostFilter = useComboboxFilter();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [
            {
              value: "auto",
              label: autoEnvironmentLabel ?? "Auto balance",
              description:
                autoEnvironmentDisabledReason ??
                "Automatically choose the least busy available machine.",
            },
          ]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
        description: "Run this thread on this machine.",
      })),
    ],
    [availableEnvironments, autoEnvironmentLabel, autoEnvironmentDisabledReason, onAutoEnvironment],
  );
  const filteredEnvironmentItems = useMemo(
    () => environmentItems.filter((item) => hostFilter.contains(item.label, query)),
    [environmentItems, hostFilter, query],
  );
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setHighlightedValue(null);
    }
  };
  const selectEnvironmentItem = (item: (typeof environmentItems)[number]) => {
    if (item.value === "auto" && autoEnvironmentDisabledReason) {
      setHighlightedValue("auto");
      return false;
    }
    if (item.value === "auto") onAutoEnvironment?.();
    else onEnvironmentChange?.(item.value as EnvironmentId);
    return true;
  };
  const hostJumpLabels = usePickerShortcuts({
    picker: "host",
    open: open && !envLocked && onEnvironmentChange !== undefined,
    items: filteredEnvironmentItems,
    keybindings,
    onSelect: (item) => {
      if (selectEnvironmentItem(item)) handleOpenChange(false);
    },
  });
  const contextItem =
    filteredEnvironmentItems.find((item) => item.value === highlightedValue) ??
    filteredEnvironmentItems.find((item) => item.value === "auto");

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onEnvironmentChange === undefined) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
        />
        <ComposerContextLabel displayMode={displayMode}>
          {activeEnvironment?.label ?? "Run on"}
        </ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Combobox
      autoHighlight
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (!eventDetails.isCanceled) handleOpenChange(nextOpen);
      }}
      filteredItems={filteredEnvironmentItems}
      onItemHighlighted={(item) => setHighlightedValue(item?.value ?? null)}
      filter={null}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.value}
      value={
        environmentItems.find(
          (item) => item.value === (autoEnvironmentLabel ? "auto" : environmentId),
        ) ?? null
      }
      onValueChange={(item, eventDetails) => {
        if (!item) return;
        if (!selectEnvironmentItem(item)) eventDetails.cancel();
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsComboboxControl
              panel={displayMode === "panel"}
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon
              className={
                displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
              }
              aria-hidden="true"
            />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className={
                displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
              }
            />
          )}
          <ComposerContextLabel displayMode={displayMode}>
            {autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup shortcut={hostShortcut}>
          {autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}
        </TooltipPopup>
      </Tooltip>
      <ComboboxPopup
        {...(displayMode === "toolbar" ? composerFloatingLayerProps : {})}
        className={cn("min-w-64", displayMode === "panel" ? "w-(--anchor-width)" : "w-72")}
      >
        <ComboboxSearchInput
          autoFocus
          aria-label="Search hosts"
          placeholder="Search hosts..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matches found.</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof environmentItems)[number]) => (
            <ComboboxItem
              key={item.value}
              value={item}
              aria-disabled={item.value === "auto" && Boolean(autoEnvironmentDisabledReason)}
              aria-describedby={
                item.value === "auto" && autoEnvironmentDisabledReason
                  ? disabledReasonId
                  : undefined
              }
            >
              {item.value === "auto" ? (
                <ScaleIcon className="size-3" />
              ) : (
                <EnvironmentMachineIcon
                  kind={
                    availableEnvironments.find((env) => env.environmentId === item.value)
                      ?.machine ?? "server"
                  }
                  className="size-3"
                />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {hostJumpLabels.has(item) ? (
                <Kbd variant="plain" aria-hidden>
                  {hostJumpLabels.get(item)}
                </Kbd>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
        <div className="min-h-16 shrink-0 border-t border-border/70">
          <ComboboxStatus>
            {contextItem?.description ?? "Choose the machine that will run this thread."}
          </ComboboxStatus>
        </div>
        {autoEnvironmentDisabledReason ? (
          <span id={disabledReasonId} className="sr-only">
            {autoEnvironmentDisabledReason}
          </span>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
});
