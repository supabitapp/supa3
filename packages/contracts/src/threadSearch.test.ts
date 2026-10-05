import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { OrchestrationSearchThreadMessagesInput } from "./threadSearch.ts";

const threadId = ThreadId.make("thread:find");
const decodeSearchInput = Schema.decodeSync(OrchestrationSearchThreadMessagesInput);
const decodeSearchInputExit = Schema.decodeExit(OrchestrationSearchThreadMessagesInput);

describe("current-thread message search input", () => {
  it("trims literal input and accepts single-character searches", () => {
    expect(decodeSearchInput({ threadId, query: "  %  " })).toEqual({ threadId, query: "%" });
  });

  it.each([
    { query: " " },
    { query: "a".repeat(201) },
    { query: "needle", offset: -1 },
    { query: "needle", offset: 0.5 },
    { query: "needle", limit: 0 },
    { query: "needle", limit: 51 },
  ])("rejects invalid or unbounded searches: %j", (input) => {
    expect(Exit.isFailure(decodeSearchInputExit({ threadId, ...input }))).toBe(true);
  });
});
