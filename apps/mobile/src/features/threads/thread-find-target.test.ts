import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@supacode/contracts";
import { threadFindSnippetParts } from "./thread-find-target";

describe("threadFindSnippetParts", () => {
  it("highlights the selected raw UTF-16 occurrence with the server snippet offset", () => {
    expect(
      threadFindSnippetParts({
        index: 1,
        threadId: ThreadId.make("thread"),
        itemId: TurnItemId.make("message"),
        snippet: "😀 **needle** needle",
        snippetStart: 100,
        start: 114,
        end: 120,
      }),
    ).toEqual({ before: "😀 **needle** ", match: "needle", after: "" });
  });
});
