import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlProviderError,
  type ChangeRequest,
  type GitHubSettings,
  type SourceControlProviderDiscoveryItem,
} from "@supacode/contracts";

import { HostProcessEnvironment } from "@supacode/shared/hostProcess";

import * as ServerSettings from "../serverSettings.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import {
  effectiveGitHubAccount,
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
  type GitHubAuthStatusAccount,
} from "./gitHubAuthStatus.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  probeSourceControlProvider,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const decodeLinkSubject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ title: Schema.String, body: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

function toChangeRequest(summary: GitHubCli.GitHubPullRequestSummary): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state ?? "open",
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function authAccounts(accounts: ReadonlyArray<GitHubAuthStatusAccount>) {
  return accounts.map((entry) => ({
    host: entry.host,
    account: entry.account,
    active: entry.active,
    authenticated: entry.authenticated,
    ...(entry.error === null ? {} : { error: entry.error }),
    ...(entry.environmentVariable === null
      ? {}
      : { environmentVariable: entry.environmentVariable }),
  }));
}

/**
 * Reads `gh auth status --json hosts`. The headline account is the one GitHub requests will
 * use: Settings can pin a login per host or turn a host off, and an environment token beats both.
 */
export function parseGitHubAuth(
  input: SourceControlAuthProbeInput,
  settings: GitHubSettings = DEFAULT_SERVER_SETTINGS.github,
) {
  const output = combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const hosts = [...new Set(authStatus.accounts.map((entry) => entry.host))];
  const fallback = findAuthenticatedGitHubAccount(authStatus.accounts);
  // Lead with the host gh would pick, unless Settings turned it off.
  const orderedHosts = fallback
    ? [fallback.host, ...hosts.filter((host) => host !== fallback.host)]
    : hosts;
  const chosen = orderedHosts
    .map((host) => effectiveGitHubAccount(host, authStatus.accounts, settings))
    .find((entry) => entry !== undefined);
  const accounts = authStatus.parsed ? { accounts: authAccounts(authStatus.accounts) } : {};

  if (chosen) {
    return {
      ...providerAuth({
        status: "authenticated",
        account: chosen.account,
        host: chosen.host,
        detail:
          chosen.environmentVariable === null
            ? undefined
            : `Using ${chosen.environmentVariable} from the server environment; it overrides the account chosen in Settings.`,
      }),
      ...accounts,
    };
  }

  if (fallback) {
    return {
      ...providerAuth({
        status: "unauthenticated",
        host: fallback.host,
        detail: "Every GitHub host gh is signed in to is turned off in Settings → Source Control.",
      }),
      ...accounts,
    };
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return {
      ...providerAuth({
        status: "unauthenticated",
        host: failedAccount?.host,
        detail:
          failedAccount?.error ??
          "Run `gh auth login` to authenticate GitHub CLI with an active account.",
      }),
      ...accounts,
    };
  }

  // gh gained `auth status --json` in 2.81.0. Older versions reject the flag and exit
  // non-zero, which reads exactly like a signed-out CLI. Name the real problem instead.
  if (input.exitCode !== 0 && output.includes("unknown flag: --json")) {
    return providerAuth({
      status: "unknown",
      detail:
        "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.",
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);

/** The environment variable GitHubCredentials would use for this host, if one is set. */
function environmentTokenVariable(host: string, environment: NodeJS.ProcessEnv): string | null {
  const token = GitHubCredentials.environmentToken(host, environment);
  if (token === null) return null;
  const names =
    host === "github.com" || host.endsWith(".ghe.com")
      ? ["GH_TOKEN", "GITHUB_TOKEN"]
      : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
  return names.find((name) => environment[name]?.trim() === token) ?? null;
}

interface DiscoveryTokenHost {
  readonly host: string;
  readonly source: "settings" | "environment";
  readonly environmentVariable?: string;
}

function discoveryTokenHosts(
  settings: GitHubSettings,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<DiscoveryTokenHost> {
  const enabledSavedHosts = Object.entries(settings.tokens)
    .flatMap(([host, token]) =>
      token.trim() !== "" && settings.hosts[host]?.enabled !== false
        ? [{ host, source: "settings" as const }]
        : [],
    )
    .toSorted((left, right) => {
      // Keep the historical dotcom-first choice when several saved tokens are usable.
      if (left.host === "github.com") return -1;
      if (right.host === "github.com") return 1;
      return left.host.localeCompare(right.host);
    });
  const savedHosts = new Set(enabledSavedHosts.map((entry) => entry.host));
  const seenHosts = new Set(savedHosts);
  const environmentHosts = ["github.com", environment.GH_HOST?.trim().toLowerCase()].flatMap(
    (host) => {
      if (!host || seenHosts.has(host) || settings.hosts[host]?.enabled === false) {
        return [];
      }
      seenHosts.add(host);
      const environmentVariable = environmentTokenVariable(host, environment);
      return environmentVariable === null
        ? []
        : [{ host, source: "environment" as const, environmentVariable }];
    },
  );
  return [...enabledSavedHosts, ...environmentHosts];
}

function discoveryTokenAuthAccounts(cli: SourceControlProviderDiscoveryItem) {
  return cli.auth.accounts === undefined ? {} : { accounts: cli.auth.accounts };
}

/**
 * GitHub is usable with a token saved in Settings, one from the environment, or `gh` to hand one
 * over. Reads the
 * GitHub settings on every probe, so a saved account choice shows on rescan. An environment
 * token is checked against the API, since `gh auth status` may not know it.
 */
export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const process = yield* VcsProcess.VcsProcess;
  const environment = yield* HostProcessEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("GitHubSourceControlProvider.discovery")(function* (cwd: string) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((current) => current.github),
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.github),
      );
      const cli = yield* probeSourceControlProvider({
        cwd,
        process,
        spec: { ...discovery, parseAuth: (input) => parseGitHubAuth(input, settings) },
      });
      const tokenHosts = discoveryTokenHosts(settings, environment);
      if (tokenHosts.length === 0) return cli;

      let firstInvalid: DiscoveryTokenHost | undefined;
      let firstUnknown:
        | { readonly candidate: DiscoveryTokenHost; readonly detail: string }
        | undefined;
      for (const candidate of tokenHosts) {
        const viewer = yield* api
          .rest({ host: candidate.host, operation: "discovery", path: "user" })
          .pipe(Effect.result);
        if (Result.isSuccess(viewer)) {
          const login = Option.getOrUndefined(decodeViewer(viewer.success.body))?.login;
          if (login !== undefined) {
            return {
              ...cli,
              status: "available" as const,
              auth: {
                ...providerAuth({
                  status: "authenticated",
                  account: login,
                  host: candidate.host,
                  detail:
                    candidate.source === "settings"
                      ? `Using the token saved for ${candidate.host}; it overrides the environment and gh login for that host.`
                      : `Using ${candidate.environmentVariable} from the server environment; it overrides the account chosen in Settings.`,
                }),
                ...discoveryTokenAuthAccounts(cli),
              },
            } satisfies SourceControlProviderDiscoveryItem;
          }
          firstUnknown ??= {
            candidate,
            detail: `GitHub returned an unreadable account for ${candidate.host}.`,
          };
          continue;
        }
        if (viewer.failure._tag === "GitHubApiAuthenticationError") {
          firstInvalid ??= candidate;
        } else {
          // Only a refusal says the token is bad; a network error or pause says nothing.
          firstUnknown ??= { candidate, detail: viewer.failure.message };
        }
      }

      const accounts = discoveryTokenAuthAccounts(cli);
      const failed =
        firstUnknown ??
        (firstInvalid === undefined
          ? undefined
          : {
              candidate: firstInvalid,
              detail:
                firstInvalid.source === "settings"
                  ? `GitHub refused the token saved for ${firstInvalid.host}. Replace or remove it in Settings → Source Control.`
                  : `GitHub refused the token in ${firstInvalid.environmentVariable}. Replace it, or unset it to use \`gh auth login\`.`,
            });
      if (failed === undefined) return cli;
      const cliHost = Option.getOrUndefined(cli.auth.host);
      if (
        cli.auth.status === "authenticated" &&
        cliHost !== undefined &&
        tokenHosts.every((candidate) => candidate.host !== cliHost)
      ) {
        return cli;
      }
      return {
        ...cli,
        status: "available" as const,
        auth: {
          ...providerAuth({
            status: firstUnknown === undefined ? "unauthenticated" : "unknown",
            host: failed.candidate.host,
            detail:
              firstUnknown === undefined
                ? failed.detail
                : `Could not check the token for ${failed.candidate.host}: ${failed.detail}`,
          }),
          ...accounts,
        },
      } satisfies SourceControlProviderDiscoveryItem;
    }),
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const api = yield* GitHubApi.GitHubApi;

  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    (input) => {
      if (input.state === "open") {
        return github
          .listOpenPullRequests({
            cwd: input.cwd,
            headSelector: input.headSelector,
            ...(input.context === undefined
              ? {}
              : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: "github",
                  operation: "listChangeRequests",
                  command: error.command,
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.headSelector,
                  ),
                  detail: error.message,
                  cause: error,
                }),
            ),
          );
      }

      return github
        .listPullRequestsByHead({
          cwd: input.cwd,
          headSelector: input.headSelector,
          state: input.state,
          limit: input.limit ?? 20,
          ...(input.context === undefined
            ? {}
            : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
        })
        .pipe(
          Effect.map((items) =>
            items.map(({ updatedAt, ...summary }) => ({
              ...toChangeRequest({
                ...summary,
                ...(Option.isSome(updatedAt)
                  ? { updatedAt: DateTime.formatIso(updatedAt.value) }
                  : {}),
              }),
              updatedAt,
            })),
          ),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.message,
                cause: error,
              }),
          ),
        );
    };

  const readLinkSubject = Effect.fn("GitHubSourceControlProvider.readLinkSubject")(function* (
    input: { readonly cwd: string; readonly url: URL },
    endpoint: string,
  ) {
    const result = yield* api
      .rest({
        host: input.url.host,
        operation: "resolveLink",
        path: endpoint,
        maxResponseBytes: 1_000_000,
      })
      .pipe(
        Effect.timeout("3 seconds"),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "resolveLink",
              cwd: input.cwd,
              detail: "The linked subject could not be read.",
              cause,
            }),
        ),
      );
    const subject = yield* decodeLinkSubject(result.body).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: "github",
            operation: "resolveLink.decode",
            cwd: input.cwd,
            detail: "The linked subject could not be read.",
            cause,
          }),
      ),
    );
    return { title: subject.title, body: subject.body ?? null };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    resolveLink: (input) => {
      // Automatic enrichment must not send ambient CLI credentials to a host from message text.
      if (input.url.host !== "github.com") return undefined;
      const match = /^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(
        input.url.pathname,
      );
      if (!match) return undefined;
      return readLinkSubject(input, `repos/${match[1]}/${match[2]}/issues/${match[3]}`);
    },
    listChangeRequests,
    getChangeRequest: (input) =>
      github
        .getPullRequest({
          ...input,
          ...(input.context === undefined
            ? {}
            : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
        })
        .pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "getChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.message,
                cause: error,
              }),
          ),
        ),
    createChangeRequest: (input) =>
      github
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.message,
                cause: error,
              }),
          ),
        ),
    getRepositoryCloneUrls: (input) =>
      github.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.message,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      github.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.message,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      github
        .getDefaultBranch({
          ...input,
          ...(input.context === undefined
            ? {}
            : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "getDefaultBranch",
                command: error.command,
                cwd: input.cwd,
                detail: error.message,
                cause: error,
              }),
          ),
        ),
    checkoutChangeRequest: (input) =>
      github.checkoutPullRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "checkoutChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.message,
              cause: error,
            }),
        ),
      ),
  });
});
