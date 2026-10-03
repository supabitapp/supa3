export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill"
  | "slash-skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * Detect an active trigger (@path, $skill, /command at prompt start, /skill
 * elsewhere) at the cursor position.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const promptPrefix = text.slice(0, cursor);
  const commandStart = promptPrefix.length - promptPrefix.trimStart().length;
  const commandPrefix = promptPrefix.slice(commandStart);

  if (commandPrefix.startsWith("/") && !commandPrefix.includes("\n")) {
    const commandMatch = /^\/(\S*)$/.exec(commandPrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: commandStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: commandStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(commandPrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: commandStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  let tokenEnd = cursor;
  while (tokenEnd < text.length && !wsCheck(text[tokenEnd] ?? "")) {
    tokenEnd += 1;
  }
  if (token.startsWith("/") && !text.slice(tokenStart + 1, tokenEnd).includes("/")) {
    return {
      kind: "slash-skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
