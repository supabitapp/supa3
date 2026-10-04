async function existingOrMissing(request) {
  try {
    return (await request()).data;
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
}

/** Check immutable release identities before building and again before the first publish. */
async function assertReleaseVersionAvailable({
  github,
  context,
  version,
  channel,
  sha,
  now = Date.now(),
  fetchRegistry = fetch,
}) {
  const [Effect, policy, semver, cliRelease] = await Promise.all([
    import("effect/Effect"),
    import("../../scripts/lib/release-version.ts"),
    import("../../packages/shared/src/semver.ts"),
    import("../../packages/shared/src/cliRelease.ts"),
  ]);
  const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  const coreVersion = version.split("-", 1)[0];
  await Effect.runPromise(policy.validateCalendarReleaseVersion(coreVersion, date));
  if (channel === "stable" && version !== coreVersion) {
    throw new Error(
      "Stable releases require a plain calendar version. Use the preview channel for prereleases.",
    );
  }
  if (cliRelease.cliReleaseChannelOf(version) !== channel) {
    throw new Error(`Release ${version} does not belong to ${channel}.`);
  }

  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  if (channel !== "preview") {
    const latestStable = releases
      .filter((release) => !release.draft && release.published_at)
      .map(
        (release) =>
          /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name)?.[1],
      )
      .filter((version) => version !== undefined)
      .sort((left, right) => semver.compareSemverVersions(right, left))[0];
    if (latestStable && semver.compareSemverVersions(coreVersion, latestStable) <= 0) {
      throw new Error(
        `Release target ${coreVersion} must be newer than published stable ${latestStable}. Prepare the next release target on main.`,
      );
    }
  }

  const tag = `v${version}`;
  const [release, commit] = await Promise.all([
    existingOrMissing(() => github.rest.repos.getReleaseByTag({ ...context.repo, tag })),
    existingOrMissing(() => github.rest.repos.getCommit({ ...context.repo, ref: tag })),
  ]);
  if (release) throw new Error(`GitHub release ${tag} already exists.`);
  if (commit && commit.sha !== sha)
    throw new Error(`Tag ${tag} already points to a different commit.`);

  const packages = [
    "supacode",
    ...cliRelease.CLI_ARCHIVE_PLATFORM_KEYS.map((key) => `@supabitapp/supacode-${key}`),
  ];
  await Promise.all(
    packages.map(async (name) => {
      const response = await fetchRegistry(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (response.status === 200)
        throw new Error(
          `npm package ${name}@${version} already exists. Use a fresh release version.`,
        );
      if (response.status !== 404)
        throw new Error(`Could not check npm package ${name}@${version} (${response.status}).`);
    }),
  );
}

module.exports = { assertReleaseVersionAvailable };
