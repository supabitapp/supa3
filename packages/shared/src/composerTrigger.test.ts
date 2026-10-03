import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, serializeComposerFileLink } from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );

  it("treats a leading slash as a command and a later slash as a skill", () => {
    expect(detectComposerTrigger("/rev", 4)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: 4,
    });
    expect(detectComposerTrigger("/model", 6)?.kind).toBe("slash-model");

    for (const text of ["Use /rev", "/plan then /rev", "Intro\n/rev"]) {
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "rev",
        rangeStart: text.length - 4,
        rangeEnd: text.length,
      });
    }
  });

  it("leaves slash paths inside a message alone", () => {
    const text = "Read /Users/khoi/notes";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
