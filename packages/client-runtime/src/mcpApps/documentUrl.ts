const MIN_URL_LIFE_MS = 5 * 60_000;

export async function resolveMcpAppDocumentUrl(input: {
  readonly cached: { readonly url: string; readonly expiresAt: number } | null;
  readonly nowMs: number;
  readonly refresh: () => Promise<string | null>;
  readonly forceRefresh?: boolean;
}): Promise<string | null> {
  if (
    input.forceRefresh !== true &&
    input.cached !== null &&
    input.cached.expiresAt - input.nowMs > MIN_URL_LIFE_MS
  ) {
    return input.cached.url;
  }
  return input.refresh();
}
