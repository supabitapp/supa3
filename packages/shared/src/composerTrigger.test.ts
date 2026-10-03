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

  it.each(["/rev", " /rev", "\n/rev"])("treats %j as a command at the prompt start", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: text.length - 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use /rev", "/plan then /rev", "Intro\n/rev"])(
    "treats a later slash as a skill search in %j",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "slash-skill",
        query: "rev",
        rangeStart: text.length - 4,
        rangeEnd: text.length,
      });
    },
  );

  it.each([
    ["Read /Users/khoi/notes", "Read /Users/khoi/notes".length],
    ["Read /Users/khoi/notes", "Read /Use".length],
  ])("leaves slash paths in %j alone with the caret at %i", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
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
