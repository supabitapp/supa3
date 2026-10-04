const assert = require("node:assert/strict");
const test = require("node:test");
const { assertReleaseVersionAvailable } = require("./check-release-version.cjs");

function fixture({ releases = [], release, tagSha, registryStatus = 404 } = {}) {
  const registryUrls = [];
  const notFound = () => {
    throw Object.assign(new Error("not found"), { status: 404 });
  };
  return {
    registryUrls,
    options: {
      context: { repo: { owner: "example", repo: "app" } },
      version: "26.0.0",
      channel: "stable",
      sha: "candidate",
      now: Date.parse("2026-10-04T12:00:00Z"),
      github: {
        async paginate() {
          return releases;
        },
        rest: {
          repos: {
            listReleases() {},
            async getReleaseByTag() {
              return release ? { data: release } : notFound();
            },
            async getCommit() {
              return tagSha ? { data: { sha: tagSha } } : notFound();
            },
          },
        },
      },
      async fetchRegistry(url) {
        registryUrls.push(url);
        return { status: registryStatus };
      },
    },
  };
}

test("accepts a legacy-to-calendar upgrade and the matching tag-triggered commit", async () => {
  const { options, registryUrls } = fixture({
    releases: [{ tag_name: "v0.0.46", published_at: "2026-10-03T00:00:00Z" }],
    tagSha: "candidate",
  });
  await assertReleaseVersionAvailable(options);
  assert.equal(registryUrls.length, 6);
  assert.ok(registryUrls.some((url) => url.includes("supacode/26.0.0")));
});

test("compares the highest published stable numerically, independent of publication order", async () => {
  const { options } = fixture({
    releases: [
      { tag_name: "v26.9.0", published_at: "2026-10-03T00:00:00Z" },
      { tag_name: "v26.10.0", published_at: "2026-10-02T00:00:00Z" },
      { tag_name: "v27.0.0", draft: true },
    ],
  });
  options.version = "26.9.1";
  await assert.rejects(
    assertReleaseVersionAvailable(options),
    /newer than published stable 26.10.0/,
  );
  options.version = "26.10.1";
  await assertReleaseVersionAvailable(options);
});

test("a nightly must preview a target beyond published stable while preview remains isolated", async () => {
  const { options } = fixture({
    releases: [{ tag_name: "v26.0.0", published_at: "2026-10-03T00:00:00Z" }],
  });
  options.version = "26.0.0-nightly.20261004.123";
  options.channel = "nightly";
  await assert.rejects(assertReleaseVersionAvailable(options), /must be newer/);
  options.version = "26.0.0-preview.20261004.124";
  options.channel = "preview";
  await assertReleaseVersionAvailable(options);
});

test("rejects old-year publication, stable prereleases, and channel disagreement", async () => {
  const { options } = fixture();
  options.now = Date.parse("2027-01-01T00:00:00Z");
  await assert.rejects(assertReleaseVersionAvailable(options), /Expected release year 27/);
  options.now = Date.parse("2026-10-04T00:00:00Z");
  options.version = "26.0.0-beta.1";
  await assert.rejects(assertReleaseVersionAvailable(options), /plain calendar version/);
  options.channel = "nightly";
  await assert.rejects(assertReleaseVersionAvailable(options), /does not belong/);
});

test("rejects an existing GitHub release, a conflicting tag, or any partially published npm version", async () => {
  await assert.rejects(
    assertReleaseVersionAvailable(fixture({ release: { id: 1 } }).options),
    /GitHub release .* already exists/,
  );
  await assert.rejects(
    assertReleaseVersionAvailable(fixture({ tagSha: "other" }).options),
    /different commit/,
  );
  await assert.rejects(
    assertReleaseVersionAvailable(fixture({ registryStatus: 200 }).options),
    /npm package .* already exists/,
  );
  const { options } = fixture();
  options.fetchRegistry = async (url) => ({ status: url.includes("linux-x64") ? 200 : 404 });
  await assert.rejects(
    assertReleaseVersionAvailable(options),
    /supacode-linux-x64@26.0.0 already exists/,
  );
});

test("fails closed when registry or GitHub checks are unavailable", async () => {
  await assert.rejects(
    assertReleaseVersionAvailable(fixture({ registryStatus: 503 }).options),
    /Could not check npm/,
  );
  const { options } = fixture();
  options.github.rest.repos.getCommit = async () => {
    throw Object.assign(new Error("GitHub unavailable"), { status: 500 });
  };
  await assert.rejects(assertReleaseVersionAvailable(options), /GitHub unavailable/);
});
