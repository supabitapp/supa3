import { Fragment, Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";
import { collectInlineContextIds } from "~/lib/composerContextReferences";

/**
 * Pure document model for the rich text (Tiptap) composer.
 *
 * The stored prompt stays markdown (`**bold**`, `@file` chips as canonical
 * links). The Tiptap document holds styled text plus inline atom chips, so
 * this module translates both ways and maps cursor offsets between the three
 * coordinate spaces the composer speaks:
 *
 * - flat document offsets (styled markers excluded, chips count 1),
 * - collapsed cursor offsets (markers literal, chips count 1 — the coordinate
 *   the draft store and mention detection use),
 * - markdown offsets (markers literal, chips expand to their source).
 *
 * DOM-free on purpose: unit tests build a real ProseMirror document from the
 * JSON this produces and assert the round trip without a browser.
 */

export type SkillMeta = { label: string; description: string | null };

/** Outermost mark first, so closers mirror openers when nested. */
const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

const MARK_TO_TIPTAP: Record<RichTextMark, string> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

const TIPTAP_TO_MARK: Record<string, RichTextMark> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

function codeBlockSource(
  node: ProseMirrorNode,
  followed: boolean,
): {
  open: string;
  content: string;
  close: string;
} {
  const attrs = node.attrs as Record<string, unknown>;
  let fence = typeof attrs.fence === "string" && attrs.fence ? attrs.fence : "```";
  const language = typeof attrs.language === "string" ? attrs.language : "";
  let close = typeof attrs.close === "string" ? attrs.close : "";
  const content = node.textContent;

  let longest = 0;
  for (const line of content.split("\n")) {
    if (isClosingFence(line, fence)) {
      longest = Math.max(longest, /^[`~]+/.exec(line)![0].length);
    }
  }
  if (longest > 0) {
    fence = fence[0]!.repeat(longest + 1);
    if (close) close = `\n${fence}`;
  }

  if (!close && followed) close = `\n${fence}`;
  return { open: `${fence}${language}${content ? "\n" : ""}`, content, close };
}

function isTrailingLineAfterRule(doc: ProseMirrorNode, index: number): boolean {
  const block = doc.child(index);
  return (
    index === doc.childCount - 1 &&
    index > 0 &&
    block.type.name === "paragraph" &&
    block.content.size === 0 &&
    doc.child(index - 1).type.name === "horizontalRule"
  );
}

function randomNodeKey(): string {
  return `tiptap-${Math.random().toString(36).slice(2)}`;
}

interface TaskLinePrefix {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[3] ?? " ").toLowerCase() === "x",
      markerSpace: match[2]!,
      contentSpace: match[4]!,
    },
    markerLength: match[0].length,
  };
}

export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  const match = /^(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const language = match[2]!;
  if (fence.startsWith("`") && language.includes("`")) return null;
  return { fence, language };
}

export function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence[0] && run.length >= fence.length;
}

type ListLinePrefix =
  | ({ kind: "task" } & TaskLinePrefix)
  | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };

function parseListPrefix(line: string): { prefix: ListLinePrefix; markerLength: number } | null {
  const task = parseTaskPrefix(line);
  if (task) return { prefix: { kind: "task", ...task.prefix }, markerLength: task.markerLength };
  const ordered = /^([ \t]*)(\d+[.)])((?:[ \t]+)|$)/.exec(line);
  if (ordered) {
    return {
      prefix: { kind: "ordered", indent: ordered[1]!, marker: ordered[2]!, space: ordered[3]! },
      markerLength: ordered[0].length,
    };
  }
  const bullet = /^([ \t]*)([-*+])((?:[ \t]+)|$)/.exec(line);
  if (bullet) {
    return {
      prefix: { kind: "bullet", indent: bullet[1]!, marker: bullet[2]!, space: bullet[3]! },
      markerLength: bullet[0].length,
    };
  }
  return null;
}

function listKey(prefix: ListLinePrefix): string {
  if (prefix.kind === "task") return "task";
  if (prefix.kind === "ordered") return `ordered:${prefix.marker.slice(-1)}`;
  return `bullet:${prefix.marker}`;
}

type InlineJson = Record<string, unknown>;

interface DocLine {
  list: ListLinePrefix | null;
  inline: InlineJson[];
}

function atomJsonForSegment(
  segment: Exclude<ReturnType<typeof splitPromptIntoComposerSegments>[number], { type: "text" }>,
  skillLabelFor: (name: string) => SkillMeta,
): InlineJson {
  if (segment.type === "mention") {
    return {
      type: "composer-mention",
      attrs: { path: segment.path, source: segment.source },
    };
  }
  if (segment.type === "skill") {
    const meta = skillLabelFor(segment.name);
    return {
      type: "composer-skill",
      attrs: {
        skillName: segment.name,
        skillLabel: meta.label,
        skillDescription: meta.description,
      },
    };
  }
  if (segment.type === "citation") {
    return {
      type: "composer-citation",
      attrs: { citation: segment.citation, source: segment.source, citeKey: randomNodeKey() },
    };
  }
  return {
    type: "composer-context-reference",
    attrs: {
      kind: segment.kind,
      contextId: segment.contextId,
      label: segment.label,
      source: segment.source,
    },
  };
}

interface PendingItem {
  prefix: ListLinePrefix;
  content: InlineJson[];

  children: PendingList[];
}

interface PendingList {
  key: string;
  items: PendingItem[];
}

function listJson(list: PendingList): InlineJson {
  const first = list.items[0]!.prefix;
  const items = list.items.map((item) => {
    const content = [
      { type: "paragraph", content: item.content },
      ...item.children.map((child) => listJson(child)),
    ];
    if (item.prefix.kind === "task") {
      return {
        type: "taskItem",
        attrs: {
          checked: item.prefix.checked,
          indent: item.prefix.indent,
          markerSpace: item.prefix.markerSpace,
          contentSpace: item.prefix.contentSpace,
        },
        content,
      };
    }
    return {
      type: "listItem",
      attrs: { indent: item.prefix.indent, marker: item.prefix.marker, space: item.prefix.space },
      content,
    };
  });
  if (first.kind === "task") return { type: "taskList", content: items };
  if (first.kind === "ordered") {
    return {
      type: "orderedList",
      attrs: { start: Number.parseInt(first.marker, 10) || 1 },
      content: items,
    };
  }
  return { type: "bulletList", content: items };
}

function textJsonForSpan(text: string, marks: RichTextMark[]): Record<string, unknown> {
  const json: Record<string, unknown> = { type: "text", text };
  if (marks.length > 0) {
    json.marks = [...marks]
      .sort((a, b) => MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b))
      .map((mark) => ({ type: MARK_TO_TIPTAP[mark] }));
  }
  return json;
}

export function buildTiptapContent(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean; blocks?: boolean },
): Record<string, unknown>[] {
  const styling = options?.styling ?? true;

  const blockSyntax = styling && (options?.blocks ?? true);
  // Hide token source from the markdown parser, then restore the atoms with
  // the marks of their surrounding text. Choose a sentinel absent from input.
  let sentinel = "\uFFFC";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: InlineJson[] = [];

  const atomSources: string[] = [];
  const text = splitPromptIntoComposerSegments(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      atoms.push(atomJsonForSegment(segment, skillLabelFor));
      atomSources.push(segment.source);
      return sentinel;
    })
    .join("");
  let atomIndex = 0;
  const buildInline = (content: string): InlineJson[] => {
    const spans = styling ? parseInlineMarkdown(content) : [{ text: content, marks: [] }];
    const inline: InlineJson[] = [];
    for (const span of spans) {
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0) {
          const atom = atoms[atomIndex++]!;
          inline.push({ ...atom, marks: textJsonForSpan("", span.marks).marks });
        }
        if (piece) inline.push(textJsonForSpan(piece, span.marks));
      });
    }
    return inline;
  };
  const buildDocLine = (line: string): DocLine => {
    const parsed = blockSyntax ? parseListPrefix(line) : null;
    const content = parsed ? line.slice(parsed.markerLength) : line;
    return { list: parsed?.prefix ?? null, inline: buildInline(content) };
  };

  const sourceLines = text.split("\n");
  const entries: (
    | { code: Record<string, unknown> }
    | { rule: string }
    | { heading: { level: number; space: string; inline: InlineJson[] } }
    | { quote: { prefix: string; inline: InlineJson[] } }
    | { line: DocLine }
  )[] = [];
  const restoreSources = (line: string) =>
    line.split(sentinel).reduce((joined, piece, index) => {
      if (index === 0) return piece;
      atomIndex += 1;
      return joined + atomSources[atomIndex - 1]! + piece;
    }, "");

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index]!;
    const opening = blockSyntax ? parseOpeningFence(line) : null;
    if (!opening) {
      if (blockSyntax && /^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/.test(line)) {
        entries.push({ rule: line });
        continue;
      }
      const heading = blockSyntax ? /^(#{1,6})([ \t]+)([^\n]*)$/.exec(line) : null;
      if (heading) {
        entries.push({
          heading: {
            level: heading[1]!.length,
            space: heading[2]!,
            inline: buildInline(heading[3]!),
          },
        });
        continue;
      }
      const quote = blockSyntax ? /^(>[ \t]*)([^\n]*)$/.exec(line) : null;
      if (quote) entries.push({ quote: { prefix: quote[1]!, inline: buildInline(quote[2]!) } });
      else entries.push({ line: buildDocLine(line) });
      continue;
    }

    const language = restoreSources(opening.language);
    const body: string[] = [];
    let cursor = index + 1;
    let close = "";
    while (cursor < sourceLines.length) {
      const candidate = sourceLines[cursor]!;
      if (isClosingFence(candidate, opening.fence)) {
        close = `\n${candidate}`;
        break;
      }
      body.push(restoreSources(candidate));
      cursor += 1;
    }

    const closed = cursor < sourceLines.length;
    const content = body.join("\n");
    entries.push({
      code: {
        type: "codeBlock",
        attrs: { language, fence: opening.fence, close },
        ...(content ? { content: [{ type: "text", text: content }] } : {}),
      },
    });
    index = closed ? cursor : sourceLines.length;
  }

  const blocks: Record<string, unknown>[] = [];
  let rootLists: PendingList[] = [];
  let stack: { indent: string; list: PendingList; container: PendingList[] }[] = [];
  const flushLists = () => {
    for (const list of rootLists) blocks.push(listJson(list));
    rootLists = [];
    stack = [];
  };
  const openList = (container: PendingList[], key: string): PendingList => {
    const list = { key, items: [] };
    container.push(list);
    return list;
  };
  let openQuote: { prefix: string; content: InlineJson[][] } | null = null;
  const flushQuote = () => {
    if (!openQuote) return;
    blocks.push({
      type: "blockquote",
      attrs: { prefix: openQuote.prefix },
      content: openQuote.content.map((inline) => ({ type: "paragraph", content: inline })),
    });
    openQuote = null;
  };
  for (const entry of entries) {
    if ("quote" in entry) {
      flushLists();
      if (openQuote && openQuote.prefix !== entry.quote.prefix) flushQuote();
      openQuote ??= { prefix: entry.quote.prefix, content: [] };
      openQuote.content.push(entry.quote.inline);
      continue;
    }
    flushQuote();
    if ("code" in entry) {
      flushLists();
      blocks.push(entry.code);
      continue;
    }
    if ("rule" in entry) {
      flushLists();
      blocks.push({ type: "horizontalRule", attrs: { source: entry.rule } });
      continue;
    }
    if ("heading" in entry) {
      flushLists();
      blocks.push({
        type: "heading",
        attrs: { level: entry.heading.level, space: entry.heading.space },
        content: entry.heading.inline,
      });
      continue;
    }
    const line = entry.line;
    if (!line.list) {
      flushLists();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingItem = { prefix: line.list, content: line.inline, children: [] };
    const key = listKey(line.list);
    const indent = line.list.indent;
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent, list: openList(rootLists, key), container: rootLists });
        continue;
      }
      if (top.indent === indent) {
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      if (top.indent !== "" && !indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = indent;
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      const parent = top.list.items[top.list.items.length - 1];
      if (!parent) {
        top.list.items.push(item);
        break;
      }
      const list = openList(parent.children, key);
      stack.push({ indent, list, container: parent.children });
      list.items.push(item);
      break;
    }
  }
  flushQuote();
  flushLists();
  return blocks;
}

export function buildDocJson(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean },
) {
  const content = buildTiptapContent(value, skillLabelFor, options);

  if (content.at(-1)?.type === "horizontalRule") content.push({ type: "paragraph" });
  return { type: "doc", content };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset (atoms count 1, markers excluded). */
  flatStart: number;
  docLen: number;
  /** Collapsed cursor length (markers literal, tokens count 1). */
  collapsedLen: number;
  /** Markdown length (tokens expand to their source). */
  mdLen: number;
  /** Marker layout inside text runs. */
  openLen: number;
  closeLen: number;
  /** ProseMirror position of the run start. */
  pmPos: number;
  mdStart: number;
  collapsedStart: number;
  nodeName?: string;
}

export interface RichDocMap {
  value: string;
  runs: RichRun[];
  docLength: number;
  contextIds: string[];
}

function readAtomSource(node: ProseMirrorNode): string {
  const attrs = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "composer-mention":
    case "composer-citation":
    case "composer-context-reference":
      return typeof attrs.source === "string" ? attrs.source : "";
    case "composer-skill": {
      const name = typeof attrs.skillName === "string" ? attrs.skillName : "";
      return name ? `$${name}` : "";
    }
    default:
      return "";
  }
}

interface RichAccumulator {
  runs: RichRun[];
  value: string;
  flat: number;
  collapsed: number;
  md: number;
}

function pushBreakRun(acc: RichAccumulator, position?: number): void {
  const previous = acc.runs[acc.runs.length - 1];
  const pmPos = position ?? (previous ? previous.pmPos + previous.docLen : 1);
  // Block boundary: one newline in every coordinate space.
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    collapsedLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
    collapsedStart: acc.collapsed,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.collapsed += 1;
  acc.md += 1;
}

function appendInlineRuns(
  container: ProseMirrorNode,
  contentStart: number,
  acc: RichAccumulator,
): void {
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "code")) {
      children.push(child);
      return;
    }
    // Separate boundary whitespace so delimiters can move past it without
    // changing the document offsets or marks on the visible text.
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  // Emphasis cannot open or close next to whitespace. Retain a whitespace
  // mark only when its range has visible content on both sides.
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (
          child.type.name === "hardBreak" ||
          !child.marks.some((item) => item.type.name === mark)
        ) {
          hasContent = false;
        } else if (
          child.isText &&
          !child.marks.some((item) => item.type.name === "code") &&
          /^\s+$/.test(child.text!)
        ) {
          if (!hasContent)
            children[index] = child.mark(child.marks.filter((item) => item.type.name !== mark));
        } else {
          hasContent = true;
        }
      }
    }
  }
  // Longer shared marks surround shorter ones. This keeps both nested
  // formatting and formatting across chips inside a single delimiter pair.
  const markEnds = new Map<RichTextMark, number>();
  const orderedMarks: RichTextMark[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const marks =
      child.type.name === "hardBreak"
        ? []
        : child.marks
            .map((mark) => TIPTAP_TO_MARK[mark.type.name])
            .filter((mark): mark is RichTextMark => Boolean(mark));
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    orderedMarks[index] = marks.sort(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! ||
        MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
    );
  }
  for (let index = 1; index < orderedMarks.length; index += 1) {
    const marks = orderedMarks[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of orderedMarks[index - 1]!) {
      if (!marks.includes(mark)) break;
      retained.push(mark);
    }
    orderedMarks[index] = [...retained, ...marks.filter((mark) => !retained.includes(mark))];
  }
  const commonLength = (left: RichTextMark[], right: RichTextMark[]) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
  };
  let inlineOffset = 0;
  children.forEach((child, index) => {
    const pmPos = contentStart + inlineOffset;
    inlineOffset += child.nodeSize;
    if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      return;
    }
    const marks = orderedMarks[index]!;
    const open = marks
      .slice(commonLength(marks, orderedMarks[index - 1] ?? []))
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const close = marks
      .slice(commonLength(marks, orderedMarks[index + 1] ?? []))
      .toReversed()
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const source = child.isText ? child.text! : readAtomSource(child);
    const docLen = child.isText ? source.length : 1;
    const mdText = open + source + close;
    const collapsedLen = open.length + docLen + close.length;
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      collapsedLen,
      mdLen: mdText.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
      ...(child.isText ? {} : { nodeName: child.type.name }),
    });
    acc.value += mdText;
    acc.flat += docLen;
    acc.collapsed += collapsedLen;
    acc.md += mdText.length;
  });
  // Empty paragraphs have an editable position even though they emit no text.
  if (children.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
  }
}

const LIST_NODE_NAMES = new Set(["taskList", "bulletList", "orderedList"]);
const LIST_ITEM_NODE_NAMES = new Set(["taskItem", "listItem"]);

function listItemPrefix(item: ProseMirrorNode, empty: boolean): string {
  const attrs = item.attrs as Record<string, unknown>;
  const indent = typeof attrs.indent === "string" ? attrs.indent : "";
  if (item.type.name === "taskItem") {
    const markerSpace = typeof attrs.markerSpace === "string" ? attrs.markerSpace : " ";
    const contentSpace =
      typeof attrs.contentSpace === "string"
        ? attrs.contentSpace || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    return `${indent}-${markerSpace}[${attrs.checked === true ? "x" : " "}]${contentSpace}`;
  }
  const marker = typeof attrs.marker === "string" && attrs.marker ? attrs.marker : "-";

  const space =
    typeof attrs.space === "string" ? attrs.space || (empty ? "" : " ") : empty ? "" : " ";
  return `${indent}${marker}${space}`;
}

function walkList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
    const prefix = listItemPrefix(item, empty);

    // to the start of the item text, exactly like style markers.
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: prefix.length,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: itemContentStart + 1,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += prefix;
    acc.collapsed += prefix.length;
    acc.md += prefix.length;
    let childPos = itemContentStart;
    let firstBlock = true;
    item.content.forEach((child) => {
      if (!firstBlock) pushBreakRun(acc);
      firstBlock = false;
      if (LIST_NODE_NAMES.has(child.type.name)) {
        walkList(child, childPos, acc);
      } else if (child.type.name === "paragraph") {
        appendInlineRuns(child, childPos + 1, acc);
      }
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

function appendCodeBlockRun(
  block: ProseMirrorNode,
  pmPos: number,
  followed: boolean,
  acc: RichAccumulator,
): void {
  const { open, content, close } = codeBlockSource(block, followed);
  const source = open + content + close;
  const segments = splitPromptIntoComposerSegments(source);
  let regionStart = 0;
  let contentOffset = 0;
  for (const [index, region] of [open, content, close].entries()) {
    const kind = index === 1 ? "text" : "prefix";
    const regionEnd = regionStart + region.length;
    const appendPiece = (mdLen: number, collapsedLen: number) => {
      const docLen = kind === "text" ? mdLen : 0;
      acc.runs.push({
        kind,
        flatStart: acc.flat,
        docLen,
        collapsedLen,
        mdLen,
        openLen: 0,
        closeLen: 0,
        pmPos: pmPos + contentOffset,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
        nodeName: "codeBlock",
      });
      contentOffset += docLen;
      acc.flat += docLen;
      acc.collapsed += collapsedLen;
      acc.md += mdLen;
    };
    if (region.length === 0 && kind === "text") appendPiece(0, 0);
    let segmentStart = 0;
    for (const segment of segments) {
      const segmentLength = segment.type === "text" ? segment.text.length : segment.source.length;
      const from = Math.max(regionStart, segmentStart);
      const to = Math.min(regionEnd, segmentStart + segmentLength);
      if (from < to) {
        const mdLen = to - from;
        const collapsedLen = segment.type === "text" ? mdLen : from === segmentStart ? 1 : 0;
        appendPiece(mdLen, collapsedLen);
      }
      segmentStart += segmentLength;
      if (segmentStart >= regionEnd) break;
    }
    regionStart = regionEnd;
  }
  acc.value += source;
}

function walkBlockquote(quote: ProseMirrorNode, quoteStart: number, acc: RichAccumulator): void {
  const attrs = quote.attrs as Record<string, unknown>;
  const prefix = typeof attrs.prefix === "string" ? attrs.prefix : "> ";
  let childPos = quoteStart + 1;
  let firstLine = true;
  quote.content.forEach((child) => {
    if (!firstLine) pushBreakRun(acc);
    firstLine = false;
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: prefix.length,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: childPos + 1,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += prefix;
    acc.collapsed += prefix.length;
    acc.md += prefix.length;
    if (child.type.name === "paragraph") appendInlineRuns(child, childPos + 1, acc);
    childPos += child.nodeSize;
  });
}

export function serializeSelection(doc: ProseMirrorNode, from: number, to: number): string {
  const slice = doc.slice(from, to);
  const $from = doc.resolve(from);
  let depth = $from.sharedDepth(to);
  let content: Fragment | ProseMirrorNode = slice.content;
  if (slice.content.firstChild?.isInline) {
    content = doc.type.schema.nodes.paragraph!.create(null, slice.content);
  } else {
    while (depth > 0) {
      const shared = $from.node(depth);
      content = shared.copy(Fragment.from(content));
      if (!LIST_ITEM_NODE_NAMES.has(shared.type.name)) break;
      depth -= 1;
    }
  }
  return serializeEditorDoc(doc.type.create(null, content)).value;
}

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, collapsed: 0, md: 0 };
  const blocks: ProseMirrorNode[] = [];
  doc.content.forEach((node) => {
    blocks.push(node);
  });

  let pmBlockStart = 0;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0 && !isTrailingLineAfterRule(doc, blockIndex)) pushBreakRun(acc);
    if (LIST_NODE_NAMES.has(block.type.name)) {
      walkList(block, pmBlockStart, acc);
    } else if (block.type.name === "codeBlock") {
      appendCodeBlockRun(block, pmBlockStart + 1, blockIndex < blocks.length - 1, acc);
    } else if (block.type.name === "blockquote") {
      walkBlockquote(block, pmBlockStart, acc);
    } else if (block.type.name === "heading") {
      const attrs = block.attrs as Record<string, unknown>;
      const level = typeof attrs.level === "number" ? attrs.level : 1;
      const space = typeof attrs.space === "string" ? attrs.space : " ";
      const prefix = `${"#".repeat(level)}${space}`;
      acc.runs.push({
        kind: "prefix",
        flatStart: acc.flat,
        docLen: 0,
        collapsedLen: prefix.length,
        mdLen: prefix.length,
        openLen: 0,
        closeLen: 0,
        pmPos: pmBlockStart + 1,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
      });
      acc.value += prefix;
      acc.collapsed += prefix.length;
      acc.md += prefix.length;
      appendInlineRuns(block, pmBlockStart + 1, acc);
    } else if (block.type.name === "horizontalRule") {
      const attrs = block.attrs as Record<string, unknown>;
      const source = typeof attrs.source === "string" && attrs.source ? attrs.source : "---";
      acc.runs.push({
        kind: "prefix",
        flatStart: acc.flat,
        docLen: 0,
        collapsedLen: source.length,
        mdLen: source.length,
        openLen: 0,
        closeLen: 0,
        pmPos: pmBlockStart + block.nodeSize,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
      });
      acc.value += source;
      acc.collapsed += source.length;
      acc.md += source.length;
    } else if (block.type.name === "paragraph") {
      appendInlineRuns(block, pmBlockStart + 1, acc);
    }
    pmBlockStart += block.nodeSize;
  });

  return {
    value: acc.value,
    runs: acc.runs,
    docLength: acc.flat,
    contextIds: Array.from(new Set(collectInlineContextIds(acc.value))),
  };
}

function lastRunEnd(map: RichDocMap, space: "collapsed" | "md"): number {
  const last = map.runs[map.runs.length - 1];
  if (!last) return 0;
  return space === "collapsed"
    ? last.collapsedStart + last.collapsedLen
    : last.mdStart + last.mdLen;
}

function runOwnsOffset(run: RichRun, flatOffset: number): boolean {
  const end = run.flatStart + run.docLen;
  return (
    flatOffset < end || (flatOffset === end && run.kind === "text" && run.nodeName === "codeBlock")
  );
}

export function flatToCollapsed(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (runOwnsOffset(run, bounded)) {
      if (run.kind === "text" || run.kind === "token") {
        const within = Math.min(
          bounded - run.flatStart,
          run.collapsedLen - run.openLen - run.closeLen,
        );
        return run.collapsedStart + run.openLen + within;
      }
      return run.collapsedStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "collapsed");
}

export function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (runOwnsOffset(run, bounded)) {
      if (run.kind === "text" || run.kind === "token") {
        return run.mdStart + run.openLen + (bounded - run.flatStart);
      }
      return run.mdStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "md");
}

export function collapsedToFlat(map: RichDocMap, collapsedOffset: number): number {
  for (const run of map.runs) {
    if (collapsedOffset < run.collapsedStart + run.collapsedLen) {
      // Checkbox prefixes and style markers are shown, never edited: every
      // offset inside them clamps to the adjacent document position.
      if (run.kind === "prefix") return run.flatStart;
      if (run.kind === "text" || run.kind === "token") {
        const within = collapsedOffset - run.collapsedStart;
        const contentLen = run.collapsedLen - run.openLen - run.closeLen;
        // Marker characters clamp to the styled edge: they are shown, never edited.
        if (within <= run.openLen) return run.flatStart;
        if (within >= run.openLen + contentLen) return run.flatStart + run.docLen;
        return run.flatStart + (within - run.openLen);
      }
      return run.flatStart + (collapsedOffset - run.collapsedStart);
    }
  }
  return map.docLength;
}

export function flatToPm(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      return run.pmPos + (bounded - run.flatStart);
    }
  }
  const last = map.runs[map.runs.length - 1];
  if (!last) return 1;
  return last.pmPos + last.docLen;
}

export function pmToFlat(map: RichDocMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos >= run.pmPos && pmPos <= run.pmPos + run.docLen) {
      // A position on a chip's trailing edge belongs after the chip.
      if (run.kind === "token" && pmPos === run.pmPos + run.docLen) {
        return run.flatStart + run.docLen;
      }
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  // A paragraph boundary position belongs to the newline between paragraphs.
  let best = 0;
  for (const run of map.runs) {
    if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  }
  return Math.max(0, Math.min(best, map.docLength));
}

// ── Caret stops at styled edges ────────────────────────────────────────────
//
// Markers are decorations, not text, so the position where styled text meets
// unstyled text (or a paragraph edge) is a single document position. The
// caret gets two stops there: one that types with the marks before the edge
// and one that types with the marks after it. Stored marks pick the stop, and
// the revealed markers render on the matching side of the caret, so a pasted
// `**bold**` at the start of a line can still be typed in front of.

function styledEdge(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.inlineContent) return null;
  const before = $from.nodeBefore?.marks ?? Mark.none;
  const after = $from.nodeAfter?.marks ?? Mark.none;
  if (Mark.sameSet(before, after)) return null;
  return { before, after, current: state.storedMarks ?? $from.marks() };
}

/** True when the caret sits on a styled edge and types with the marks before it. */
export function caretTakesMarksBefore(state: EditorState): boolean {
  const edge = styledEdge(state);
  return edge !== null && Mark.sameSet(edge.current, edge.before);
}

/**
 * Moves the caret to the other stop of the styled edge it sits on, toward
 * `direction`. Returns null when there is no stop to take, so the arrow key
 * moves the caret as usual.
 */
export function stepCaretAcrossStyledEdge(
  state: EditorState,
  direction: -1 | 1,
): Transaction | null {
  const edge = styledEdge(state);
  if (!edge) return null;
  // Marks the user toggled by hand (neither stop) are theirs: move as usual.
  if (!Mark.sameSet(edge.current, edge.before) && !Mark.sameSet(edge.current, edge.after)) {
    return null;
  }
  const target = direction === -1 ? edge.before : edge.after;
  if (Mark.sameSet(edge.current, target)) return null;
  return state.tr.setStoredMarks(target);
}
