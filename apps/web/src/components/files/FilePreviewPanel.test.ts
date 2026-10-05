import { describe, expect, it } from "vite-plus/test";
import { decodeFilePreviewText, FILE_TEXT_PREVIEW_MAX_BYTES } from "@supacode/shared/filePreview";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
  resolveMarkdownTaskPreviewUpdate,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
} from "./filePreviewMode";

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("shouldShowFileExplorer", () => {
  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("rendered markdown task updates", () => {
  it("refuses a task update from a bounded prefix of a larger document", () => {
    const markdown = `- [ ] First task\n${"a".repeat(FILE_TEXT_PREVIEW_MAX_BYTES)}\nTail must survive`;
    const preview = decodeFilePreviewText(new TextEncoder().encode(markdown));

    expect(preview.truncated).toBe(true);
    expect(preview.text).not.toContain("Tail must survive");
    expect(
      resolveMarkdownTaskPreviewUpdate(
        { contents: preview.text, truncated: preview.truncated },
        2,
        true,
      ),
    ).toBeNull();
  });

  it("keeps complete documents editable without dropping their tail", () => {
    const markdown = "- [ ] First task\n- [x] Second task\nTail must survive\n";
    const file = { contents: markdown, truncated: false };
    const checked = resolveMarkdownTaskPreviewUpdate(file, 2, true);
    expect(checked).toBe("- [x] First task\n- [x] Second task\nTail must survive\n");
    if (checked === null) expect.unreachable("expected a complete task update");
    expect(resolveMarkdownTaskPreviewUpdate({ ...file, contents: checked }, 2, false)).toBe(
      markdown,
    );
  });

  it("does not schedule writes for an unchanged or stale task marker", () => {
    const file = { contents: "- [x] Already checked\n", truncated: false };
    expect(resolveMarkdownTaskPreviewUpdate(file, 2, true)).toBeNull();
    expect(resolveMarkdownTaskPreviewUpdate(file, 20, false)).toBeNull();
  });
});

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});
