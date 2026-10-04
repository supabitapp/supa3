const assert = require("node:assert/strict");
const test = require("node:test");
const { findBuilds, recordBuild } = require("./mobile-build-history.cjs");

const fingerprint = "a".repeat(40);
const context = {
  repo: { owner: "supacode", repo: "supacode" },
  serverUrl: "https://github.com",
  runId: 123,
};
const options = { context, profile: "production", platform: "ios", version: "2.0.0", fingerprint };
const payload = (overrides = {}) => ({
  schema: 1,
  profile: "production",
  platform: "ios",
  version: "2.0.0",
  fingerprint,
  url: "https://github.com/supacode/supacode/actions/runs/123",
  ...overrides,
});

function client(pages, statuses = {}) {
  const queries = [];
  const github = {
    rest: {
      repos: {
        listDeployments: "deployments",
        listDeploymentStatuses: async ({ deployment_id }) => ({
          data: [{ state: statuses[deployment_id] ?? "success" }],
        }),
      },
    },
    paginate: {
      async *iterator(_method, query) {
        queries.push(query);
        for (const data of pages) yield { data };
      },
    },
  };
  return { github, queries };
}

test("looks past failed and incomplete deployments and paginates build history", async () => {
  const { github, queries } = client(
    [
      [
        { id: 1, payload: payload() },
        { id: 2, payload: payload() },
      ],
      [{ id: 3, payload: payload() }],
    ],
    { 1: "failure", 2: "pending" },
  );
  const result = await findBuilds({ ...options, github });
  assert.deepEqual(result, { versionBuild: payload(), compatibleBuild: payload() });
  assert.equal(queries[0].environment, "mobile-production-ios");
  assert.equal(queries[0].task, "mobile-build");
});

test("native drift keeps the version build but prevents OTA compatibility", async () => {
  const built = payload({ fingerprint: "b".repeat(40) });
  const { github } = client([[{ id: 1, payload: built }]]);
  assert.deepEqual(await findBuilds({ ...options, github }), {
    versionBuild: built,
    compatibleBuild: undefined,
  });
});

test("an older compatible binary allows updates but does not suppress a new version build", async () => {
  const built = payload({ version: "2.0.1" });
  const { github } = client([[{ id: 1, payload: built }]]);
  assert.deepEqual(await findBuilds({ ...options, version: "2.0.2", github }), {
    versionBuild: undefined,
    compatibleBuild: built,
  });
});

test("preview, other platforms, and malformed records cannot satisfy production", async () => {
  const { github } = client([
    [null, { profile: "v2-preview" }, { platform: "android" }, { schema: 2 }].map(
      (override, id) => ({ id, payload: override === null ? null : payload(override) }),
    ),
  ]);
  assert.deepEqual(await findBuilds({ ...options, github }), {
    versionBuild: undefined,
    compatibleBuild: undefined,
  });
});

test("records the built commit and preserves previous compatible deployments", async () => {
  const calls = [];
  const github = {
    rest: {
      repos: {
        createDeployment: async (request) => {
          calls.push(request);
          return { data: { id: 42 } };
        },
        createDeploymentStatus: async (request) => {
          calls.push(request);
        },
      },
    },
  };
  await recordBuild({ ...options, github, sha: "b".repeat(40), url: payload().url });
  assert.equal(calls[0].ref, "b".repeat(40));
  assert.equal(calls[0].auto_merge, false);
  assert.deepEqual(calls[0].required_contexts, []);
  assert.deepEqual(calls[0].payload, payload());
  assert.equal(calls[1].state, "success");
  assert.equal(calls[1].auto_inactive, false);
});

test("rejects recording builds without a valid embedded fingerprint", async () => {
  await assert.rejects(
    recordBuild({ ...options, fingerprint: "", github: {} }),
    /embedded fingerprint/,
  );
});

test("surfaces history API failures rather than scheduling duplicate builds", async () => {
  const { github } = client([[{ id: 1, payload: payload() }]]);
  github.rest.repos.listDeploymentStatuses = async () => {
    throw new Error("API unavailable");
  };
  await assert.rejects(findBuilds({ ...options, github }), /API unavailable/);
});
