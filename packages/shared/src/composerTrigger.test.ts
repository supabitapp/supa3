import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it.each([" /rev", "\n\n/rev"])(
    "detects a slash command after leading whitespace in %j",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "slash-command",
        query: "rev",
        rangeStart: text.length - 4,
        rangeEnd: text.length,
      });
    },
  );

  it.each(["Use /rev", "/plan then /rev", "Intro\n/rev"])(
    "detects a slash skill trigger after the prompt start in %j",
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

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %sskill trigger at cursor",
    (prefix) => {
      const text = `Use ${prefix}gh-fi`;
      const trigger = detectComposerTrigger(text, text.length);

      expect(trigger).toEqual({
        kind: "skill",
        query: "gh-fi",
        rangeStart: "Use ".length,
        rangeEnd: text.length,
      });
    },
  );

  it("detects a pull request number at a token boundary", () => {
    const text = "Compare this with #8737";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "8737",
      rangeStart: "Compare this with ".length,
      rangeEnd: text.length,
    });
  });

  it("opens pull request completion from a bare hash", () => {
    const text = "Compare with #";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "",
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it("detects a one-word pull request search", () => {
    const text = "Compare with #composer";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "composer",
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it("supports hyphenated pull request search terms", () => {
    const text = "Find #inline-context";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "inline-context",
      rangeStart: "Find ".length,
      rangeEnd: text.length,
    });
  });

  it("does not keep pull request completion active for headings or embedded hashes", () => {
    expect(detectComposerTrigger("# Heading", "# Heading".length)).toBeNull();
    expect(detectComposerTrigger("issue#123", "issue#123".length)).toBeNull();
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
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
