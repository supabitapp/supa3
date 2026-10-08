import { useSyncExternalStore } from "react";
import { isMacPlatform } from "@supacode/shared/keybindings";
import { isEditableFocused } from "./lib/editableFocus";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

export function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

let modifierState = EMPTY_SHORTCUT_MODIFIER_STATE;
let nonEditableModifierState = EMPTY_SHORTCUT_MODIFIER_STATE;
const listeners = new Set<() => void>();

function updateModifierStates(next: ShortcutModifierState, nonEditable: ShortcutModifierState) {
  if (
    areShortcutModifierStatesEqual(modifierState, next) &&
    areShortcutModifierStatesEqual(nonEditableModifierState, nonEditable)
  ) {
    return;
  }
  modifierState = next;
  nonEditableModifierState = nonEditable;
  for (const listener of listeners) listener();
}

function onKeyboardEvent(event: KeyboardEvent) {
  updateModifierStates(
    shortcutModifierStateAfterKeyboardEvent(modifierState, event),
    isEditableFocused(event.target)
      ? EMPTY_SHORTCUT_MODIFIER_STATE
      : shortcutModifierStateAfterKeyboardEvent(nonEditableModifierState, event),
  );
}

function onResetEvent() {
  updateModifierStates(EMPTY_SHORTCUT_MODIFIER_STATE, EMPTY_SHORTCUT_MODIFIER_STATE);
}

function onFocus(event: FocusEvent) {
  if (isEditableFocused(event.target)) {
    updateModifierStates(modifierState, EMPTY_SHORTCUT_MODIFIER_STATE);
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKeyboardEvent, true);
    window.addEventListener("keyup", onKeyboardEvent, true);
    window.addEventListener("paste", onResetEvent, true);
    window.addEventListener("blur", onResetEvent);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("focusin", onFocus);
    window.removeEventListener("keydown", onKeyboardEvent, true);
    window.removeEventListener("keyup", onKeyboardEvent, true);
    window.removeEventListener("paste", onResetEvent, true);
    window.removeEventListener("blur", onResetEvent);
    onResetEvent();
  };
}

const getModifierState = () => modifierState;
const getNonEditableModifierState = () => nonEditableModifierState;
const getEmptyModifierState = () => EMPTY_SHORTCUT_MODIFIER_STATE;

export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  return useSyncExternalStore(
    subscribe,
    ignoreEditable ? getNonEditableModifierState : getModifierState,
    getEmptyModifierState,
  );
}

const getShortcutHintsVisible = () =>
  isMacPlatform(navigator.platform) ? modifierState.metaKey : modifierState.ctrlKey;
const getHiddenShortcutHints = () => false;

export function useShortcutHintsVisible() {
  return useSyncExternalStore(subscribe, getShortcutHintsVisible, getHiddenShortcutHints);
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Flags on non-modifier keys may only clear a bit, never set one. After a
    // dictation tool's synthetic ⌘V (Wispr Flow), the browser can keep
    // reporting metaKey=true on real key events (Enter to submit) until the
    // user physically taps ⌘. Trusting that flag would mark ⌘ as held and
    // stick the thread jump hints. Setting a bit requires a real modifier
    // keydown, handled above.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
