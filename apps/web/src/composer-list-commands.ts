import type { Command, Editor } from "@tiptap/core";
import { joinBackward, joinTextblockBackward, joinTextblockForward } from "@tiptap/pm/commands";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";

import { nextOrderedMarkerText } from "./composer-list-continuation";

const LIST_NODE_NAMES = new Set(["taskList", "bulletList", "orderedList"]);

function alignListItemWithSiblings(tr: Transaction, itemType: string): void {
  const $pos = tr.selection.$from;

  if ($pos.depth < 3 || $pos.node(-1).type.name !== itemType) return;
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const sibling =
    index > 0 ? list.child(index - 1) : index + 1 < list.childCount ? list.child(index + 1) : null;
  if (!sibling) return;
  const attrs: Record<string, unknown> = { ...item.attrs, indent: sibling.attrs.indent };
  if (item.type.name === "taskItem") {
    attrs.markerSpace = sibling.attrs.markerSpace;
  } else {
    const marker = typeof sibling.attrs.marker === "string" ? sibling.attrs.marker : "-";
    attrs.marker = index > 0 && /^\d+[.)]$/.test(marker) ? nextOrderedMarkerText(marker) : marker;
  }
  tr.setNodeMarkup($pos.before(-1), undefined, attrs);
  if (typeof attrs.marker === "string" && /^\d+[.)]$/.test(attrs.marker)) {
    renumberFollowingItems(tr, $pos.before(-2), index, attrs.marker);
  }
}

function renumberFollowingItems(
  tr: Transaction,
  listPos: number,
  index: number,
  marker: string,
): void {
  const list = tr.doc.nodeAt(listPos);
  if (!list) return;
  let pos = listPos + 1;
  let previous = marker;
  list.forEach((child, _, childIndex) => {
    if (childIndex > index) {
      previous = nextOrderedMarkerText(previous);
      if (child.attrs.marker !== previous) {
        tr.setNodeMarkup(pos, undefined, { ...child.attrs, marker: previous });
      }
    }
    pos += child.nodeSize;
  });
}

export function splitOrLiftListItem(editor: Editor): boolean {
  const $from = editor.state.selection.$from;
  const itemType = listItemTypeAt($from);
  if (!itemType) return false;
  const empty = $from.parent.content.size === 0;

  const move: Command = ({ commands, tr }) => {
    const moved =
      commands.splitListItem(
        itemType,
        itemType === "taskItem" ? { checked: false } : { space: " " },
      ) ||
      (empty && commands.liftListItem(itemType));
    if (moved) alignListItemWithSiblings(tr, itemType);
    return moved;
  };
  return editor.can().command(move) && editor.chain().command(move).run();
}

export function convertBulletItemToTask(
  tr: Transaction,
  from: number,
  to: number,
  checked: boolean,
): void {
  tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const { schema } = tr.doc.type;
  const before: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((child, _, childIndex) => {
    if (childIndex < index) before.push(child);
    else if (childIndex > index) after.push(child);
  });

  const markerSpace =
    typeof item.attrs.space === "string" && item.attrs.space ? item.attrs.space : " ";
  const task = schema.nodes.taskItem!.create(
    { checked, indent: item.attrs.indent, markerSpace },
    item.content,
  );
  const lists = [
    ...(before.length > 0 ? [list.copy(Fragment.from(before))] : []),
    schema.nodes.taskList!.create(null, task),
    ...(after.length > 0 ? [list.copy(Fragment.from(after))] : []),
  ];
  const listStart = $pos.before(-2);
  tr.replaceWith(listStart, listStart + list.nodeSize, lists);

  const caret = listStart + (before.length > 0 ? lists[0]!.nodeSize : 0) + 3;
  tr.setSelection(TextSelection.create(tr.doc, caret));
}

function listItemTypeAt($pos: ResolvedPos): "listItem" | "taskItem" | null {
  const name = $pos.depth > 1 ? $pos.node(-1).type.name : null;
  return name === "listItem" || name === "taskItem" ? name : null;
}

export function backspaceAcrossList(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const itemType = listItemTypeAt($from);
  if (itemType && $from.index(-1) === 0) {
    const lift: Command = ({ commands, tr }) => {
      const moved = commands.liftListItem(itemType);
      if (moved) alignListItemWithSiblings(tr, itemType);
      return moved;
    };

    return editor.chain().command(lift).run() || joinBackward(state, editor.view.dispatch);
  }
  const before = $from.depth === 1 ? $from.node(0).maybeChild($from.index(0) - 1) : null;
  if (before && LIST_NODE_NAMES.has(before.type.name) && $from.parent.type.name !== "codeBlock") {
    return joinTextblockBackward(state, editor.view.dispatch);
  }
  return false;
}

export function deleteAcrossList(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.depth === 0) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const next = Selection.findFrom(state.doc.resolve($from.after()), 1, true);
  if (!next) return false;
  if (next.$from.parent.type.name === "codeBlock") return $from.parent.type.name !== "codeBlock";
  if (!listItemTypeAt($from) && !listItemTypeAt(next.$from)) return false;
  return joinTextblockForward(state, editor.view.dispatch);
}
