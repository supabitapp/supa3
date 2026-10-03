import {
  SelectableMarkdownText as SupacodeSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@supacode/mobile-markdown-text/renderer";
import { useMemo } from "react";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import { renderMermaidDiagram } from "../lib/mermaidRenderer.native";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useUniwindTheme } from "../lib/useUniwindTheme";

type MobileSelectableMarkdownTextProps = Omit<
  SelectableMarkdownTextProps,
  "highlightCode" | "renderDiagram"
>;

export type {
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@supacode/mobile-markdown-text/types";

// The renderer falls back to React Native Text outside iOS, so Android can use
// the same Markdown chunking while retaining native text selection.
export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  const theme = useUniwindTheme();
  const selectionColor = themeColorWithAlpha(theme["--color-focus"], 0.32);
  const selectionHandleColor = theme["--color-focus"];
  const textStyle = useMemo(
    () => ({ selectionColor, selectionHandleColor, ...props.textStyle }),
    [props.textStyle, selectionColor, selectionHandleColor],
  );
  return (
    <SupacodeSelectableMarkdownText
      {...props}
      textStyle={textStyle}
      highlightCode={highlightCodeSnippet}
      renderDiagram={renderMermaidDiagram}
    />
  );
}
