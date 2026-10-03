import type { SelectableMarkdownTextProps } from "@supacode/mobile-markdown-text/renderer";

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
  return false;
}

export function SelectableMarkdownText(_props: MobileSelectableMarkdownTextProps) {
  return null;
}
