import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
} from "@supacode/shared/filePreview";

import { isAudioPreviewFile, isMarkdownPreviewFile, isVideoPreviewFile } from "./filePath";

export type FileViewMode = "preview" | "source";

export interface FileViewModeOverride {
  readonly path: string;
  readonly line: number | null;
  readonly mode: FileViewMode;
}

/** Line links open source; a manual mode choice applies only to that file and line target. */
export function resolveFileViewMode(input: {
  readonly path: string | null;
  readonly line: number | null;
  readonly override: FileViewModeOverride | null;
}): FileViewMode {
  if (
    input.path !== null &&
    input.override?.path === input.path &&
    input.override.line === input.line
  ) {
    return input.override.mode;
  }
  if (input.line !== null) return "source";
  return input.path !== null &&
    (isMarkdownPreviewFile(input.path) ||
      isWorkspaceBrowserPreviewPath(input.path) ||
      isWorkspaceImagePreviewPath(input.path) ||
      isVideoPreviewFile(input.path) ||
      isAudioPreviewFile(input.path))
    ? "preview"
    : "source";
}
