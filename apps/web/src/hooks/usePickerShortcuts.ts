import {
  BRANCH_PICKER_JUMP_KEYBINDING_COMMANDS,
  HOST_PICKER_JUMP_KEYBINDING_COMMANDS,
  PROJECT_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
} from "@supacode/contracts";
import { useEffect, useEffectEvent, useMemo } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";

const PICKER_COMMANDS = {
  project: PROJECT_PICKER_JUMP_KEYBINDING_COMMANDS,
  host: HOST_PICKER_JUMP_KEYBINDING_COMMANDS,
  branch: BRANCH_PICKER_JUMP_KEYBINDING_COMMANDS,
};

/** Number the supplied visible choices while their picker owns the keyboard. */
export function usePickerShortcuts<T>({
  picker,
  open,
  items,
  keybindings,
  onSelect,
}: {
  picker: keyof typeof PICKER_COMMANDS;
  open: boolean;
  items: readonly T[];
  keybindings: ResolvedKeybindingsConfig;
  onSelect: (item: T) => void;
}) {
  const commands = PICKER_COMMANDS[picker];
  const context = useMemo(
    () => ({
      modelPickerOpen: false,
      projectPickerOpen: picker === "project",
      hostPickerOpen: picker === "host",
      branchPickerOpen: picker === "branch",
    }),
    [picker],
  );
  const labels = useMemo(() => {
    const mapping = new Map<T, string>();
    if (!open) return mapping;
    for (const [index, item] of items.entries()) {
      const command = commands[index];
      if (!command) break;
      const label = shortcutLabelForCommand(keybindings, command, {
        context,
      });
      if (label) mapping.set(item, label);
    }
    return mapping;
  }, [open, items, keybindings, commands, context]);

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || isCommandPaletteOpen()) {
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      context,
    });
    const index = commands.findIndex((candidate) => candidate === command);
    if (index === -1) return;
    // Even an empty slot belongs to the picker; it must not jump to a sidebar thread.
    event.preventDefault();
    event.stopPropagation();
    const item = items[index];
    if (item !== undefined) onSelect(item);
  });

  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  return labels;
}
