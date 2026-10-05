const assert = require("node:assert/strict");
const test = require("node:test");
const { reconcilePreview, removePreview } = require("./publish-web-preview.cjs");

for (const { label, headSha, states, expected, calls } of [
  {
    label: "current commit deploys",
    headSha: "built",
    states: [
      ["OPEN", "built"],
      ["OPEN", "built"],
    ],
    expected: "deployed",
    calls: ["deploy"],
  },
  { label: "superseded build skips", headSha: "built", states: [["OPEN", "newer"]], calls: [] },
  {
    label: "closed PR removes deployment",
    headSha: "built",
    states: [["CLOSED", "built"]],
    expected: "removed",
    calls: ["remove"],
  },
  {
    label: "merged PR removes deployment",
    headSha: "built",
    states: [["MERGED", "built"]],
    expected: "removed",
    calls: ["remove"],
  },
  {
    label: "closing during upload removes deployment",
    headSha: "built",
    states: [
      ["OPEN", "built"],
      ["CLOSED", "built"],
    ],
    expected: "removed",
    calls: ["deploy", "remove"],
  },
  {
    label: "push during upload suppresses stale comment",
    headSha: "built",
    states: [
      ["OPEN", "built"],
      ["OPEN", "newer"],
    ],
    calls: ["deploy"],
  },
  {
    label: "reopened PR survives queued cleanup",
    headSha: "",
    states: [["OPEN", "built"]],
    calls: [],
  },
]) {
  test(label, async () => {
    const actualCalls = [];
    const remainingStates = [...states];
    const result = await reconcilePreview({
      headSha,
      readPull: () => {
        const [state, headRefOid] = remainingStates.shift();
        return { state, headRefOid };
      },
      deploy: async () => {
        actualCalls.push("deploy");
      },
      remove: async () => {
        actualCalls.push("remove");
      },
    });
    assert.equal(result, expected);
    assert.deepEqual(actualCalls, calls);
    assert.equal(remainingStates.length, 0);
  });
}

test("failed deployment does not report success", async () => {
  await assert.rejects(
    reconcilePreview({
      headSha: "built",
      readPull: () => ({ state: "OPEN", headRefOid: "built" }),
      deploy: async () => {
        throw new Error("deployment failed");
      },
      remove: async () => assert.fail("must not remove on deploy failure"),
    }),
    /deployment failed/,
  );
});

for (const [status, success, rejects] of [
  [200, true, false],
  [404, false, false],
  [403, false, true],
  [200, false, true],
]) {
  test(`Cloudflare cleanup: HTTP ${status}, success=${success}`, async () => {
    const run = () =>
      removePreview({
        accountId: "account",
        name: "supacode-next-preview-42",
        token: "test-token",
        request: async (url, options) => {
          assert.equal(
            url,
            "https://api.cloudflare.com/client/v4/accounts/account/workers/services/supacode-next-preview-42",
          );
          assert.equal(options.method, "DELETE");
          return { status, ok: status === 200, json: async () => ({ success }) };
        },
      });
    if (rejects) await assert.rejects(run);
    else await run();
  });
}
