import { type Editor, mergeAttributes } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Plugin, TextSelection } from "@tiptap/pm/state";

import { backspaceAcrossList, deleteAcrossList } from "./composer-list-commands";

export const ComposerCodeExtension = Code.extend({
  excludes: "code",

  exitable: false,
});

function withoutBlockChords<Shortcuts extends Record<string, unknown>>(
  shortcuts: Shortcuts | undefined,
  drop: readonly string[],
): Shortcuts {
  return Object.fromEntries(
    Object.entries(shortcuts ?? {}).filter(([key]) => !drop.includes(key)),
  ) as Shortcuts;
}

const LIST_ITEM_CONTENT = "paragraph list*";

export const ComposerTaskListExtension = TaskList.extend({
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-9"]);
  },
});

const LIST_NESTING_KEYS = ["Tab", "Shift-Tab"];

export const ComposerTaskItemExtension = TaskItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), LIST_NESTING_KEYS);
  },
}).configure({ nested: true });

export const ComposerCodeBlockExtension = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: { default: "" },
      fence: { default: "```" },
      close: { default: "\n```" },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...withoutBlockChords(this.parent?.(), ["Mod-Alt-c"]),
      Backspace: () => unwrapCodeBlockAtStart(this.editor),
    };
  },
});

function unwrapCodeBlockAtStart(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "codeBlock" || $from.parentOffset !== 0) return false;
  const { schema } = editor.state;
  const paragraphs = $from.parent.textContent
    .split("\n")
    .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
  const start = $from.before();
  const tr = editor.state.tr.replaceWith(start, $from.after(), paragraphs);
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
  return true;
}

const ComposerListItemExtension = ListItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      marker: { default: "-" },
      space: { default: " " },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...withoutBlockChords(this.parent?.(), LIST_NESTING_KEYS),

      Backspace: () => backspaceAcrossList(this.editor),
      Delete: () => deleteAcrossList(this.editor),
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["li", mergeAttributes(HTMLAttributes, { "data-marker": node.attrs.marker }), 0];
  },
});

export const ComposerListExtensions = [
  BulletList.extend({
    addKeyboardShortcuts() {
      return withoutBlockChords(this.parent?.(), ["Mod-Shift-8"]);
    },
  }),
  OrderedList.extend({
    addKeyboardShortcuts() {
      return withoutBlockChords(this.parent?.(), ["Mod-Shift-7"]);
    },
  }),
  ComposerListItemExtension,
];

const ComposerBlockquoteExtension = Blockquote.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), prefix: { default: "> " } };
  },
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-b"]);
  },
});

const ComposerHorizontalRuleExtension = HorizontalRule.extend({
  addAttributes() {
    return { ...this.parent?.(), source: { default: "---" } };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        appendTransaction: (transactions, _, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (state.doc.lastChild?.type.name !== "horizontalRule") return null;
          return state.tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create());
        },
      }),
    ];
  },
});

const ComposerHeadingExtension = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), space: { default: " " } };
  },

  addKeyboardShortcuts() {
    return {};
  },
});

export const ComposerBlockExtensions = [
  ComposerBlockquoteExtension,
  ComposerHorizontalRuleExtension,
  ComposerHeadingExtension,
];
