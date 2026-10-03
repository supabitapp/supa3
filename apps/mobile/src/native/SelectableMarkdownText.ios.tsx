import {
  SelectableMarkdownText as SupacodeSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@supacode/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import { renderMermaidDiagram } from "../lib/mermaidRenderer.native";

type MobileSelectableMarkdownTextProps = Omit<
  SelectableMarkdownTextProps,
  "highlightCode" | "renderDiagram"
>;

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@supacode/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return (
    <SupacodeSelectableMarkdownText
      {...props}
      highlightCode={highlightCodeSnippet}
      renderDiagram={renderMermaidDiagram}
    />
  );
}
