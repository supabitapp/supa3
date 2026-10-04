# Release Checklist

> For maintainers. Using Supacode? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## Calendar versions

Supacode uses `YY.MINOR.PATCH`, with the actual UTC release year minus 2000 as `YY`.
The first calendar release is `26.0.0`. Feature releases increment minor and reset patch;
fixes increment patch. For example, `26.1.0` can be followed by `26.1.1`.
The first release in 2027 is `27.0.0`. The numbers do not define wire compatibility;
the orchestration and service launcher protocols remain separate.

The aligned server, desktop, web, and contracts manifests hold the **next stable target**.
Nightlies preview that target directly. After publishing `26.0.0`, finalization prepares
`26.0.1` on main and preserves any higher feature target already prepared there.
Prepare a feature release before building its nightly candidate:

```sh
node scripts/update-release-package-versions.ts 26.1.0
```

Commit the aligned manifests, then verify their nightly before promotion. When the UTC year
changes, release tooling selects the new year's `YY.0.0`, including from an unchanged commit.
A December nightly cannot be promoted during January; verify a current-year nightly first.
Release validation runs before building and again before the first package publication.
A build that crosses the year boundary must restart with the current-year target.

Public versions must advance beyond the highest published stable. Existing GitHub releases,
conflicting tags, and any already-published npm platform package reject the release before
publication. Recover a partially published release with a fresh version; published versions
must retain their original bytes. Tag releases need the calendar release tooling on their
tagged commit, including backports.

Mobile uses the same calendar convention with independent minor and patch counters in
`apps/mobile/app.config.ts`. EAS retains its increasing native build numbers across years.
Production native builds require a current-year marketing version; compatible OTA updates
can continue serving older binaries. The stored generation in
[`fingerprint.config.js`](../../apps/mobile/fingerprint.config.js) separates OTA distribution
groups independently of the calendar year. Advance it only when users must install a new
store binary. The first calendar generation requires new binaries and isolates legacy 2.x
apps; maintaining their OTAs requires a branch with their original fingerprint configuration.
Changes merged to main can automatically build and submit mobile binaries, so coordinate
the version change with the store release window.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - manual `workflow_dispatch` with `channel=stable`, the normal way to ship stable. Stable
    and nightly dispatches must select `main`; preview may select any branch. The channel defaults
    to preview so an omitted selection cannot publish a stable release.
  - push tag matching `v*.*.*` for a stable release of an explicit commit
  - scheduled nightly check every 30 minutes
  - manual `workflow_dispatch` with `channel=nightly`
  - manual `workflow_dispatch` with `channel=preview`, the maintainers' test train. It exercises the whole release flow (build, sign, notarize, smoke, publish) for a commit that end users must never receive, which is how an unmerged branch or a risky change gets a real release run before it lands. It builds the triggering commit with nightly's versioning under the `preview` prerelease identifier (`0.0.41-preview.<date>.<run>`) and publishes a GitHub prerelease plus the npm packages under the `preview` dist-tag. Preview is not on the schedule, no default npm dist-tag points at it, its desktop builds carry no update feed, and no updater manifest (`latest*.yml`, `nightly*.yml`, blockmaps) is attached, so a stable or nightly install cannot be offered one. The only ways onto it are downloading the release by hand, `npx supacode@preview`, `SUPACODE_CHANNEL=preview` for the install scripts, or `supacode update --channel preview` from a terminal; each prints a warning, and the CLI asks for confirmation when the running build is not itself a preview. The release itself is named as a maintainer test build and its body is a warning rather than generated notes: a changelog of unmerged branch history is not a changelog, and nightly and stable notes are unaffected because each series resolves its previous tag within its own channel. The hosted web app, AUR, and Discord announcements are skipped. Keep it; it costs nothing when idle.
- A manual stable release builds the commit of the latest published nightly, not `main` HEAD.
  Nightly is the release candidate: verify the nightly, then promote it. Merges to `main` keep
  landing while you verify and never leak into the stable build.
  - The version defaults to the one the nightly previewed (`26.1.0-nightly.*` ships as `26.1.0`).
    The `version` input must match that verified nightly's core. Prepare minor targets before building their nightlies.
  - The stable tag is created on the nightly's commit when the GitHub Release is published.
  - Pushing a `vX.Y.Z` tag by hand still works and builds exactly the tagged commit. Use it when
    the commit to ship is not the latest nightly, such as a cherry-picked fix on a release branch.
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Builds the platform-independent JS (server bundle, web client, Electron main) once in the `build_bundle` job and hands it to every platform job as the `js-bundle` artifact; the platform jobs only package it, so no runner rebuilds it.
- Builds six desktop artifacts in parallel for both channels, each as its own job (`desktop_<platform>_<arch>`, one call of `release-desktop.yml`) on hardware of its own architecture, gated only on the bundle. The Windows jobs embed the same-arch Linux CLI archive as the WSL runtime and wait for that artifact partway through, not for the whole Linux job:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` and `arm64` AppImage and `.deb`, from one electron-builder run. The `.deb` updates in the app through electron-updater, which installs it with `dpkg`.
  - Windows `x64` and `arm64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags require a plain current-year `YY.MINOR.PATCH`. Use the preview channel for test releases.
  - Stable releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Builds a self-contained CLI archive per platform (`supacode-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) in the same job as that target's desktop artifact and attaches them to the GitHub Release with a `SHA256SUMS` file, on every channel, for five targets: macOS arm64, Linux x64 and arm64, Windows x64 and arm64. Every archive is built, signed, and smoke-tested on hardware of its own architecture. There is no macOS x64 archive: Node single-executables are unsupported on x64 macOS (the SEA docs list macOS as arm64 only) and the binary segfaults on start; the x64 desktop app is Electron and unaffected.
  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so unpacking it needs neither Node, npm, nor a compiler. It is the only form in which Supacode manages a runtime: the desktop's SSH environments, the boot service, `supacode update`, and the install scripts all download and verify this archive against `SHA256SUMS`. The npm packages exist for people who run `npx supacode` or `npm install -g supacode` themselves and carry the same archive contents; nothing in the product installs from npm. The `curl | sh` installers are `scripts/install.sh` and `scripts/install.ps1`; the marketing site copies them into its `public/` at build time (`apps/marketing/scripts/stage-install-scripts.mjs`) and serves them at `next.supacode.sh/install.sh` and `/install.ps1`.
  - The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION=26.8.2`, kept in step with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on `engines.node`.
  - Release macOS archives are signed with the Developer ID certificate and notarized using the Apple credentials loaded through fnox. Windows executables use the same Azure Trusted Signing setup as the installer. Every native addon in the macOS archive is signed too, since the hardened runtime refuses unsigned libraries.
  - Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`) before it is uploaded.
- Publishes the CLI to npm with OIDC trusted publishing from the same workflow file, as the same bytes the GitHub Release carries: `scripts/build-npm-platform-packages.ts` unpacks the five CLI archives into `@supabitapp/supacode-<platform>-<arch>` packages (each with `os`/`cpu` set so npm installs only the matching one) and generates the `supacode` launcher, whose `bin/supacode.js` lists them as `optionalDependencies` and execs the installed executable. `npx supacode` therefore needs Node only to run the launcher, never to run the server. `node apps/server/scripts/cli.ts publish` publishes the platform packages first and the launcher last, after a `--dry-run` pass over all of them so an auth or scope error fails before anything is live.
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
  - preview releases publish npm dist-tag `preview`, which nothing resolves unless asked for by name
  - one-time setup: the `supabitapp` npm organization must own the `@supabitapp` scope, and `supacode` and each `@supabitapp/supacode-<platform>-<arch>` package needs a trusted publisher registered for this workflow file (see below).
- Builds the hosted web app for Cloudflare while the desktop jobs run, and makes it live only after a release is published:
  - stable releases are aliased to the `latest` hosted app channel
  - nightly releases are aliased to the `nightly` hosted app channel
- Release macOS jobs require Apple credentials from 1Password. Windows signing is auto-detected from its Azure secrets.

## Pull request macOS previews

Labeling a PR `preview:mac` publishes a signed, notarized Apple Silicon DMG to the rolling
`desktop-preview` prerelease, and works for fork PRs. The label is a one-shot request
for the commit it is applied to: the trusted workflow removes it once the build is in hand, and later
pushes do not build until a maintainer applies it again. Every signed preview is therefore a
per-commit maintainer decision, which matters because the result carries the Developer ID signature.
Vouching a contributor lets their labeled commits be signed; it is not a standing grant. The build is
split so the Developer ID certificate never shares a job with PR code:

- `.github/workflows/desktop-macos-preview.yml` runs on `pull_request` with no secrets and builds
  only the JS bundle from the PR (the same `js-bundle` artifact `release.yml` produces).
- `.github/workflows/desktop-macos-preview-publish.yml` runs on `workflow_run` from `main`. It
  refuses unless the PR is open, still labeled, its head is the built commit, and the author is a
  bot, a collaborator, or listed in `.github/VOUCHED.td` (read from the default branch, so a PR cannot vouch
  for itself). It then packages and signs the bundle through `release-desktop.yml` checked out at
  `main`, so packaging, native helpers, and the Electron/desktop dependencies come from `main`, not
  the PR. Only the version is read from the PR commit, as data. A PR that changes packaging must use
  the `channel=preview` release train above instead.

Before handing the bundle to the signing runner, the trusted workflow validates its ZIP entries
and accepts only regular files under `server/dist` and `desktop/dist-electron`, plus the directory
entries that lead to those roots. The artifact cannot
overwrite packaging code or installed dependencies. The bundle is copied into the app, never executed,
on the signing runner. The
`pull_request_target` cleanup job in the publish workflow removes the download when the PR closes, or
when the label is removed by hand before a build consumed it, and never checks out PR code.

## Required release credentials

Store `OP_SERVICE_ACCOUNT_TOKEN` in the GitHub `release` environment. Its read-only 1Password service
account needs access to the `Supacode CI` vault. The environment must allow `main` for manual and
scheduled releases, plus release tags for tag-triggered runs. Preview branches need explicit access
before dispatch. The fnox profiles in [`.github/fnox.toml`](../../.github/fnox.toml) resolve the Apple
signing fields from `Apple Desktop Signing` and these fields from `GitHub Release App`:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

Credential lookup failures stop the job. The finalize job uses the App credentials to commit and push aligned package versions to `main` as the Release App.
GitHub Release publication uses the repository-scoped workflow token so it has a rate-limit quota
independent from the shared Release App installation.

## Cloudflare hosting

Cloudflare Workers serves the marketing site and hosted web client. The agent server continues to run on users' machines. Hosting configuration lives in `apps/marketing/wrangler.json` and `apps/web/cloudflare/`.

The release workflow builds static assets while desktop jobs run and uploads them as GitHub artifacts. Deployment starts only after the GitHub Release succeeds. Stable releases update `latest.app.next.supacode.sh`; nightly releases update `nightly.app.next.supacode.sh` and the marketing site at `next.supacode.sh`. Stable releases leave the marketing site unchanged because they can promote an older nightly commit.

`app.next.supacode.sh` routes requests to the selected channel. Visiting `/__supacode/channel?channel=latest` or `/__supacode/channel?channel=nightly` saves the `supacode_web_channel` cookie and redirects to the app root. Builds receive the release version through `APP_VERSION` and the channel through `VITE_HOSTED_APP_CHANNEL`.

The `cloudflare` fnox profile reads `CLOUDFLARE_API_TOKEN` from the `Cloudflare Hosting` item in the `Supacode CI` vault. The token needs Workers Scripts edit access in the configured account, plus Workers Routes edit and Zone read access for `supacode.sh`. Deployment jobs use the `release` GitHub environment. Wrangler manages the custom domains and their certificates.

Same-repository pull requests labeled `preview:web` deploy to `preview-<number>.next.supacode.sh`. The `web-preview` GitHub environment supplies `OP_SERVICE_ACCOUNT_TOKEN` for those deployments. Open the URL posted on the pull request and pair a reachable server under Settings → Connections.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every 30 minutes
  - manual `workflow_dispatch` with `channel=nightly`
- Automatic nightlies require new commits or an annual calendar rollover, plus at least six hours since the last nightly was published, including manual nightlies.
- Manual nightlies bypass the time and change checks. Nightly runs remain serialized. Scheduled runs wait for an active nightly to finish, then check the publication gap before building.
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the prepared stable target as the nightly base. For example, `26.1.0` produces `26.1.0-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI npm packages (`supacode` and `@supabitapp/supacode-<platform>-<arch>`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `supacode@<version>` package available on
npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact release version to npm, on every channel.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.
   `build_web` stages static assets as a GitHub artifact without exposing the new client. Cloudflare receives those assets only in `deploy_web`.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view supacode@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx supacode@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `SUPACODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`supacode-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
by the Linux desktop job and handed to the Windows desktop build as
`--wsl-runtime`, copied in verbatim so WSL runs the exact bytes a Linux user
downloads. WSL verifies and extracts that archive
into `~/.supacode/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `supacode-<version>-linux-<arch>` directory holding `supacode`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow runs `node scripts/build-npm-platform-packages.ts` on the downloaded CLI archives, then
`node apps/server/scripts/cli.ts publish --packages-dir npm-packages`, which runs `npm publish` on
each `@supabitapp/supacode-<platform>-<arch>.tgz` and finally on `supacode.tgz`, the launcher. The script publishes
tarballs it built itself rather than directories: `npm publish <dir>` strips `node_modules/` from the
tarball no matter what `files` says, and the executable loads its native addons from there. Six
packages are published per release: `supacode`, `@supabitapp/supacode-darwin-arm64`,
`@supabitapp/supacode-linux-arm64`, `@supabitapp/supacode-linux-x64`, `@supabitapp/supacode-win32-arm64`,
`@supabitapp/supacode-win32-x64`.

Checklist:

1. Confirm the publishing account owns `supacode` and can publish in the `@supabitapp` organization.
2. For `supacode` and each `@supabitapp/supacode-<platform>-<arch>` package, configure a Trusted Publisher in the
   npm package settings (a package that has never been published needs a first publish or a
   placeholder before the setting exists; the `--dry-run` step in `publish_cli` reports which
   names are still rejected):
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for every package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - build and smoke-test the five CLI archives
   - build the npm packages from those archives
   - publish them with npm dist-tag `latest`
5. Nightly runs publish with npm dist-tag `nightly`; preview runs with `preview`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing an accepted plain current-year release tag
classifies the run as the stable channel. It publishes `supacode` with npm dist-tag
`latest`, creates a real GitHub Release, aliases the hosted app to `latest.app.next.supacode.sh` and
`app.next.supacode.sh`, and can prepare the next stable target on `main` in the finalize job. Do not push a test tag
to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package, GitHub
prerelease, desktop updater release, hosted nightly alias, and marketing site, but it does not update stable app aliases or
commit a version bump to `main`. Only run it when a real nightly release is acceptable.

Manual `channel=stable` is also a real stable-channel release. Missing Apple credentials stop macOS release jobs. Missing Windows signing secrets produce unsigned
Windows artifacts; they do not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required fields in the `Apple Desktop Signing` item in the `Supacode CI` vault:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create a `Developer ID Application` certificate.
3. Export the certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (Team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
8. Re-run a tag release and confirm macOS artifacts are signed/notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in 1Password.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Pick the latest nightly and verify it: run the smoke test above against its artifacts and
   check the nightly channel for regressions.
2. Dispatch the Release workflow with `channel=stable`. Leave `version` empty to use the nightly's core,
   or enter that same version explicitly.
3. Confirm the `Resolve release commit` notice names the nightly tag and commit you verified. If a
   newer nightly published in between, the run builds that one instead.
4. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - `build_bundle` and all platform builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
5. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check the service account can read all Apple fields in `Supacode CI`.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Release macOS jobs require their fnox profile to resolve; use the unsigned PR preview workflow for an unsigned build.
  - Re-check certificate/profile names and tenant/client credentials.
