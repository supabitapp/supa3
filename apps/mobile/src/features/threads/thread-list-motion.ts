const MAX_CHANGED_ROWS = 20;
export const THREAD_LIST_MOTION_DURATION = 220;

/** Content-only updates and bulk replacements stay immediate, as do search and scope changes. */
export function shouldAnimateThreadList(input: {
  readonly previousKeys: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
  readonly previousScope: string;
  readonly scope: string;
  readonly searching: boolean;
}) {
  if (
    input.searching ||
    input.previousScope !== input.scope ||
    input.previousKeys.length === 0 ||
    input.keys.length === 0
  ) {
    return false;
  }
  if (
    input.keys.length === input.previousKeys.length &&
    input.keys.every((key, index) => key === input.previousKeys[index])
  ) {
    return false;
  }
  const previous = new Set(input.previousKeys);
  const next = new Set(input.keys);
  let changed = 0;
  for (const key of previous) if (!next.has(key)) changed++;
  for (const key of next) if (!previous.has(key)) changed++;
  return changed <= MAX_CHANGED_ROWS;
}
