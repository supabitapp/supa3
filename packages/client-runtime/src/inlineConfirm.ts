export const INLINE_CONFIRM_GUARD_MS = 400;
export const INLINE_CONFIRM_TIMEOUT_MS = 5000;

export interface InlineConfirm<Key extends string> {
  readonly press: (key: Key, at: number) => boolean;
  readonly disarm: (key?: Key) => void;
}

export function createInlineConfirm<Key extends string>(
  onChange: (armed: Key | null) => void,
): InlineConfirm<Key> {
  let armed: Key | null = null;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const set = (next: Key | null) => {
    clearTimeout(timer);
    timer = next === null ? undefined : setTimeout(() => set(null), INLINE_CONFIRM_TIMEOUT_MS);
    armed = next;
    onChange(next);
  };

  return {
    press: (key, at) => {
      if (armed !== key) {
        armedAt = at;
        set(key);
        return false;
      }
      if (at - armedAt < INLINE_CONFIRM_GUARD_MS) return false;
      set(null);
      return true;
    },
    disarm: (key) => {
      if (armed !== null && (key === undefined || key === armed)) set(null);
    },
  };
}
