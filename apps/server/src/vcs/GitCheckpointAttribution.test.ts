import { assert, describe, it } from "@effect/vitest";

import { parseRawDiff } from "./GitCheckpointAttribution.ts";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const modified = (path: string) => [`:100644 100644 ${OLD} ${NEW} M`, path];
const output = (records: ReadonlyArray<string>) => `${records.join("\0")}\0`;

describe("parseRawDiff", () => {
  it("pairs each raw change with its numstat counts", () => {
    const changes = parseRawDiff(
      output([...modified("a.txt"), ...modified(":colon.txt"), "3\t1\ta.txt", "-\t-\t:colon.txt"]),
      true,
    );
    assert.deepStrictEqual(
      changes && Object.fromEntries(changes),
      Object.fromEntries([
        ["a.txt", { transition: `100644 100644 ${OLD} ${NEW}`, additions: 3, deletions: 1 }],
        [":colon.txt", { transition: `100644 100644 ${OLD} ${NEW}`, additions: 0, deletions: 0 }],
      ]),
    );
  });

  it("rejects output it cannot account for", () => {
    // Truncated mid-record.
    assert.isUndefined(parseRawDiff(`:100644 100644 ${OLD} ${NEW} M\0a.txt`, false));
    // A numstat record missing for one change.
    assert.isUndefined(
      parseRawDiff(output([...modified("a.txt"), ...modified("b.txt"), "1\t0\ta.txt"]), true),
    );
    // A numstat record for a path without a raw change.
    assert.isUndefined(parseRawDiff(output([...modified("a.txt"), "1\t0\tb.txt"]), true));
    // A rename or copy record, which these diffs never request.
    assert.isUndefined(parseRawDiff(output([`:100644 100644 ${OLD} ${NEW} R100`, "a.txt"]), false));
    // Trailing records where no numstat was requested.
    assert.isUndefined(parseRawDiff(output([...modified("a.txt"), "1\t0\ta.txt"]), false));
  });
});
