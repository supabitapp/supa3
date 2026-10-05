/** Text is read in bounded UTF-8 byte chunks, independent of payload size. */
export const THREAD_MESSAGE_SEARCH_CHUNK_LENGTH = 16_384;

/** Finds non-overlapping literal matches while retaining original UTF-16 offsets. */
export function createThreadMessageMatcher(query: string) {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let readPosition = 0;
  let scanPosition = 0;
  let carry = "";

  return function* appendChunk(chunk: string, isLast: boolean) {
    const text = carry + chunk;
    const base = readPosition - carry.length;
    readPosition += chunk.length;
    // Delay matches near the end until their surrounding excerpt is available.
    const scanEnd = isLast ? text.length : Math.max(0, text.length - query.length - 240);
    pattern.lastIndex = Math.max(0, scanPosition - base);
    let match = pattern.exec(text);
    while (match !== null && match.index < scanEnd) {
      const start = base + match.index;
      const end = start + match[0].length;
      const contextBefore = Math.min(72, Math.floor((240 - match[0].length) / 2));
      const snippetOffset = Math.max(0, Math.min(match.index - contextBefore, text.length - 240));
      yield {
        start,
        end,
        snippetStart: base + snippetOffset,
        snippet: text.slice(snippetOffset, snippetOffset + 240),
      };
      scanPosition = end;
      match = pattern.exec(text);
    }
    scanPosition = Math.max(scanPosition, base + scanEnd);
    // Keep preceding context as well as the unsearched tail for boundary matches.
    carry = text.slice(-(query.length + 480));
  };
}
