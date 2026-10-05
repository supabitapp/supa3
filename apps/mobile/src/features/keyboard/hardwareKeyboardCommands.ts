import { EnvironmentId, ThreadId, type ThreadJumpKeybindingCommand } from "@supacode/contracts";
import { useCallback, useEffect, useState } from "react";

export type HardwareKeyboardCommand =
  | ThreadJumpKeybindingCommand
  | "commandPalette"
  | "paletteNext"
  | "palettePrevious"
  | "paletteDismiss"
  | "newTask"
  | "focusSearch"
  | "threadFind"
  | "back"
  | "files"
  | "terminal"
  | "review"
  | "copyThreadReference"
  | "toggleSidebar"
  | "cycleHost";

type CommandHandler = (command: HardwareKeyboardCommand) => boolean | void;

const handlers = new Map<HardwareKeyboardCommand, Set<CommandHandler>>();
const registrationListeners = new Set<() => void>();
let registrationVersion = 0;
const threadFindFocusBlockers = new Set<object>();
let pendingThreadFind: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null = null;

function notifyCommandRegistrationsChanged() {
  registrationVersion += 1;
  registrationListeners.forEach((listener) => listener());
}

/** Exclude native chat-find commands while a sidebar search field owns keyboard focus. */
export function useThreadFindFocusBlocker(enabled = true) {
  const [owner] = useState({});
  const setFocused = useCallback(
    (focused: boolean) => {
      if (threadFindFocusBlockers.has(owner) === focused) return;
      if (focused) threadFindFocusBlockers.add(owner);
      else threadFindFocusBlockers.delete(owner);
      notifyCommandRegistrationsChanged();
    },
    [owner],
  );
  const onFocus = useCallback(() => setFocused(true), [setFocused]);
  const onBlur = useCallback(() => setFocused(false), [setFocused]);
  useEffect(() => {
    if (!enabled) onBlur();
    return onBlur;
  }, [enabled, onBlur]);
  return { onFocus, onBlur };
}

export function isThreadChatPath(pathname: string): boolean {
  return /^\/threads\/[^/]+\/[^/]+\/?$/.test(pathname) && parseActiveThreadPath(pathname) !== null;
}

/** Keep Cmd/Ctrl+F on the visible chat or the search field that owns focus. */
export function nativeHardwareKeyboardCommandsForPath(
  registered: ReadonlySet<HardwareKeyboardCommand>,
  pathname: string,
) {
  const commands = new Set(registered);
  const chatVisible = isThreadChatPath(pathname);
  if (!chatVisible) commands.delete("threadFind");
  if (pathname !== "/" && !chatVisible && threadFindFocusBlockers.size === 0) {
    commands.delete("focusSearch");
  }
  return commands;
}

export function requestThreadFindOnFocus(ref: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  pendingThreadFind = ref;
}

export function takeThreadFindOnFocus(ref: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  if (
    pendingThreadFind?.environmentId !== ref.environmentId ||
    pendingThreadFind.threadId !== ref.threadId
  )
    return false;
  pendingThreadFind = null;
  return true;
}

/**
 * Registers a context-specific hardware-keyboard action. The most recently mounted handler gets
 * the first chance to consume the command, allowing focused screens to override app defaults.
 */
export function useHardwareKeyboardCommand(
  command: HardwareKeyboardCommand | ReadonlyArray<HardwareKeyboardCommand>,
  handler: CommandHandler,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const commands = typeof command === "string" ? [command] : command;
    for (const command of commands) {
      const commandHandlers = handlers.get(command) ?? new Set<CommandHandler>();
      commandHandlers.add(handler);
      handlers.set(command, commandHandlers);
    }
    notifyCommandRegistrationsChanged();
    return () => {
      for (const command of commands) {
        const commandHandlers = handlers.get(command);
        commandHandlers?.delete(handler);
        if (commandHandlers?.size === 0) handlers.delete(command);
      }
      notifyCommandRegistrationsChanged();
    };
  }, [command, handler, enabled]);
}

export function getRegisteredHardwareKeyboardCommands(): ReadonlySet<HardwareKeyboardCommand> {
  const commands = new Set(handlers.keys());
  if (threadFindFocusBlockers.size > 0) commands.delete("threadFind");
  return commands;
}

export function getHardwareKeyboardCommandRegistrationVersion(): number {
  return registrationVersion;
}

export function subscribeToHardwareKeyboardCommandRegistrations(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function dispatchHardwareKeyboardCommand(command: HardwareKeyboardCommand): boolean {
  const commandHandlers = handlers.get(command);
  if (!commandHandlers) return false;
  const handlersInRegistrationOrder = Array.from(commandHandlers);
  for (let index = handlersInRegistrationOrder.length - 1; index >= 0; index -= 1) {
    const handler = handlersInRegistrationOrder[index];
    if (!handler) continue;
    if (handler(command) !== false) return true;
  }
  return false;
}

export function parseActiveThreadPath(pathname: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      environmentId: EnvironmentId.make(decodeURIComponent(match[1])),
      threadId: ThreadId.make(decodeURIComponent(match[2])),
    };
  } catch {
    return null;
  }
}

/**
 * The machine after `currentId` in display order, wrapping around. Starts at
 * the first machine when `currentId` is not listed.
 */
export function nextEnvironmentId<T extends { readonly environmentId: string }>(
  environments: ReadonlyArray<T>,
  currentId: string | null,
): T["environmentId"] | null {
  if (environments.length < 2) return null;
  const index = environments.findIndex((environment) => environment.environmentId === currentId);
  return environments[(index + 1) % environments.length]?.environmentId ?? null;
}
