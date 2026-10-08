export function userInputCountdown(deadline: string | null | undefined, now: number) {
  if (deadline === undefined) return null;
  if (deadline === null)
    return { state: "paused" as const, text: "Kept open", label: "Automatic dismissal is paused." };
  const expiresAt = Date.parse(deadline);
  if (!Number.isFinite(expiresAt)) return null;
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (remaining === 0)
    return {
      state: "closing" as const,
      text: "Closing…",
      label: "Waiting for this question to close without an answer.",
    };
  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return {
    state: remaining <= 20 ? ("warning" as const) : ("counting" as const),
    text: `Closes in ${time}`,
    label: `Question closes without an answer in ${remaining} seconds.`,
  };
}
