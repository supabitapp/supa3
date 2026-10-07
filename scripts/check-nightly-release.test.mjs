import { describe, expect, it, vi } from "vitest";

import { shouldReleaseNightly } from "../.github/scripts/check-nightly-release.cjs";

const context = {
  repo: { owner: "supabitapp", repo: "supacode-next" },
  sha: "new-commit",
};

function releaseCheck(releases, status = "ahead") {
  const compareCommitsWithBasehead = vi.fn().mockResolvedValue({ data: { status } });
  return {
    github: {
      paginate: vi.fn().mockResolvedValue(releases),
      rest: { repos: { listReleases: vi.fn(), compareCommitsWithBasehead } },
    },
    context,
    core: { info: vi.fn() },
  };
}

const nightly = {
  tag_name: "v26.0.11-nightly.20261007.123",
  draft: false,
  published_at: "2026-10-07T12:00:00Z",
};

describe("automatic nightly releases", () => {
  it("releases when no nightly has been published", async () => {
    const check = releaseCheck([
      { ...nightly, tag_name: "v26.0.10" },
      { ...nightly, tag_name: "v26.0.11-preview.20261007.124" },
      { ...nightly, draft: true },
      { ...nightly, published_at: null },
    ]);

    await expect(shouldReleaseNightly(check)).resolves.toBe(true);
    expect(check.github.rest.repos.compareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("releases new commits even immediately after a nightly publishes", async () => {
    const check = releaseCheck([{ ...nightly, published_at: new Date().toISOString() }]);

    await expect(shouldReleaseNightly(check)).resolves.toBe(true);
    expect(check.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
      ...context.repo,
      basehead: `${nightly.tag_name}...${context.sha}`,
      per_page: 1,
    });
  });

  it.each(["identical", "behind", "diverged"])(
    "skips a commit that is %s relative to the latest nightly",
    async (status) => {
      await expect(shouldReleaseNightly(releaseCheck([nightly], status))).resolves.toBe(false);
    },
  );

  it("checks against the most recently published nightly", async () => {
    const latestNightly = {
      ...nightly,
      tag_name: "v26.0.11-nightly.20261007.124",
      published_at: "2026-10-07T12:01:00Z",
    };
    const check = releaseCheck([nightly, latestNightly]);

    await expect(shouldReleaseNightly(check)).resolves.toBe(true);
    expect(check.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
      ...context.repo,
      basehead: `${latestNightly.tag_name}...${context.sha}`,
      per_page: 1,
    });
  });
});
