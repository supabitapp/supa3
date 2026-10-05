import { describe, expect, it } from "vite-plus/test";

import { resolveFileViewMode } from "./filePreviewMode";

describe("workspace file view mode", () => {
  it.each(["README.md", "docs/guide.MDX"])("opens %s as rendered markdown", (path) => {
    expect(resolveFileViewMode({ path, line: null, override: null })).toBe("preview");
  });

  it.each(["page.html", "document.pdf", "image.png", "clip.mp4", "sound.mp3"])(
    "preserves the preview default for %s",
    (path) => {
      expect(resolveFileViewMode({ path, line: null, override: null })).toBe("preview");
    },
  );

  it.each(["src/index.ts", null])("keeps %s in source mode", (path) => {
    expect(resolveFileViewMode({ path, line: null, override: null })).toBe("source");
  });

  it("opens line links in source, including after a previous preview choice", () => {
    expect(resolveFileViewMode({ path: "README.md", line: 12, override: null })).toBe("source");
    expect(
      resolveFileViewMode({
        path: "README.md",
        line: 12,
        override: { path: "README.md", line: null, mode: "preview" },
      }),
    ).toBe("source");
    expect(
      resolveFileViewMode({
        path: "README.md",
        line: 40,
        override: { path: "README.md", line: 12, mode: "preview" },
      }),
    ).toBe("source");
  });

  it("lets readers switch both ways after opening a source-line link", () => {
    expect(
      resolveFileViewMode({
        path: "README.md",
        line: 12,
        override: { path: "README.md", line: 12, mode: "preview" },
      }),
    ).toBe("preview");
    expect(
      resolveFileViewMode({
        path: "README.md",
        line: 12,
        override: { path: "README.md", line: 12, mode: "source" },
      }),
    ).toBe("source");
  });

  it("keeps a source choice on its file while another file opens rendered", () => {
    const override = { path: "README.md", line: null, mode: "source" } as const;
    expect(resolveFileViewMode({ path: "README.md", line: null, override })).toBe("source");
    expect(resolveFileViewMode({ path: "docs/guide.md", line: null, override })).toBe("preview");
  });
});
