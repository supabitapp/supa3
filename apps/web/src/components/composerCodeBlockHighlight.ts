import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { DiffThemeName } from "~/lib/diffRendering";
import { languageOfInfoString } from "~/composer-code-languages";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

interface HighlightedBlock {
  readonly signature: string;
  readonly decorations: ReadonlyArray<{ from: number; to: number; color: string }>;
}

const composerCodeBlockHighlightKey = new PluginKey<DecorationSet>("composerCodeBlockHighlight");

export const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;

export function shouldHighlightCodeBlock(code: string): boolean {
  return code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH;
}
function blockSignature(node: ProseMirrorNode, theme: DiffThemeName): string {
  return [theme, String(node.attrs.language ?? ""), node.textContent].join("\u0000");
}

function collectCodeBlocks(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === "codeBlock") blocks.push({ node, pos });
  });
  return blocks;
}

export function composerCodeBlockHighlight(options: {
  resolveTheme: () => DiffThemeName;
}): Extension {
  return Extension.create({
    name: "composerCodeBlockHighlight",

    addProseMirrorPlugins() {
      const cache = new Map<string, HighlightedBlock>();

      let live = new Set<string>();

      return [
        new Plugin<DecorationSet>({
          key: composerCodeBlockHighlightKey,

          state: {
            init: () => DecorationSet.empty,
            apply(transaction, value, _oldState, newState) {
              if (!transaction.docChanged && !transaction.getMeta(composerCodeBlockHighlightKey)) {
                return value.map(transaction.mapping, transaction.doc);
              }
              return buildDecorations(newState, cache, options.resolveTheme());
            },
          },

          props: {
            decorations(state) {
              return composerCodeBlockHighlightKey.getState(state);
            },
          },

          view(view) {
            let disposed = false;
            let paintedTheme = options.resolveTheme();
            let scannedDoc: ProseMirrorNode | null = null;

            const refresh = () => {
              const theme = options.resolveTheme();
              const themeChanged = theme !== paintedTheme;
              paintedTheme = theme;

              if (!themeChanged && view.state.doc === scannedDoc) return;
              scannedDoc = view.state.doc;
              const blocks = collectCodeBlocks(view.state);
              live = new Set(blocks.map(({ node }) => blockSignature(node, theme)));
              for (const signature of cache.keys()) {
                if (!live.has(signature)) cache.delete(signature);
              }
              const pending = blocks.filter(
                ({ node }) =>
                  shouldHighlightCodeBlock(node.textContent) &&
                  !cache.has(blockSignature(node, theme)),
              );
              if (pending.length === 0) {
                if (themeChanged) {
                  view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
                }
                return;
              }

              void Promise.allSettled(
                pending.map(async ({ node }) => {
                  const language =
                    languageOfInfoString(String(node.attrs.language ?? "")) || "text";
                  const signature = blockSignature(node, theme);
                  const highlighter = await getSyntaxHighlighterPromise(language);
                  if (disposed || cache.has(signature) || !live.has(signature)) return;
                  cache.set(signature, {
                    signature,
                    decorations: tokenizeBlock(highlighter, node.textContent, language, theme),
                  });
                }),
              ).then(() => {
                if (disposed) return;
                view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
              });
            };

            refresh();

            const themeObserver = new MutationObserver(refresh);
            themeObserver.observe(document.documentElement, {
              attributeFilter: ["class"],
            });

            return {
              update: refresh,
              destroy() {
                disposed = true;
                themeObserver.disconnect();
              },
            };
          },
        }),
      ];
    },
  });
}

type Highlighter = Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>;

export function tokenizeBlock(
  highlighter: Highlighter,
  code: string,
  language: string,
  theme: DiffThemeName,
): ReadonlyArray<{ from: number; to: number; color: string }> {
  let tokens;
  try {
    tokens = highlighter.codeToTokens(code, { lang: language, theme }).tokens;
  } catch {
    return [];
  }

  const decorations: Array<{ from: number; to: number; color: string }> = [];
  let offset = 0;
  for (const [lineIndex, line] of tokens.entries()) {
    if (lineIndex > 0) offset += code.startsWith("\r\n", offset) ? 2 : 1;
    for (const token of line) {
      const length = token.content.length;
      if (token.color && token.content.trim()) {
        decorations.push({ from: offset, to: offset + length, color: token.color });
      }
      offset += length;
    }
  }
  return decorations;
}

function buildDecorations(
  state: EditorState,
  cache: Map<string, HighlightedBlock>,
  theme: DiffThemeName,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const { node, pos } of collectCodeBlocks(state)) {
    if (!shouldHighlightCodeBlock(node.textContent)) continue;
    const highlighted = cache.get(blockSignature(node, theme));
    if (!highlighted) continue;

    if (node.content.size !== node.textContent.length) continue;

    const start = pos + 1;
    for (const decoration of highlighted.decorations) {
      decorations.push(
        Decoration.inline(start + decoration.from, start + decoration.to, {
          style: `color:${decoration.color}`,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}
