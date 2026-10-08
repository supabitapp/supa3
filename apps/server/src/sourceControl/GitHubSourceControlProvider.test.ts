import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError } from "@supacode/contracts";
import { HostProcessEnvironment } from "@supacode/shared/hostProcess";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubRepositoryApi from "./GitHubRepositoryApi.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeProvider(
  github: Partial<GitHubRepositoryApi.GitHubRepositoryApi["Service"]>,
  api: Partial<GitHubApi.GitHubApi["Service"]> = {},
) {
  return GitHubSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(GitHubRepositoryApi.GitHubRepositoryApi)(github),
        Layer.mock(GitHubApi.GitHubApi)(api),
      ),
    ),
  );
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const restResponse = (body: string): GitHubApi.GitHubRestResponse => ({
  status: 200,
  headers: {},
  body,
  truncated: false,
  invalidUtf8: false,
});

function probeGitHubDiscovery(input: {
  readonly hosts?: Record<string, { readonly enabled?: boolean; readonly account?: string }>;
  readonly tokens?: Record<string, string>;
  readonly ghAvailable?: boolean;
  readonly ghAuthStatus?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly rest: (
    host: string,
  ) => Effect.Effect<GitHubApi.GitHubRestResponse, GitHubApi.GitHubApiError>;
}) {
  const process = Layer.mock(VcsProcess.VcsProcess)({
    run: (request) =>
      request.args[0] === "--version"
        ? input.ghAvailable
          ? Effect.succeed(processResult("gh version 2.81.0"))
          : Effect.fail(
              new VcsProcessSpawnError({
                operation: request.operation,
                command: "gh",
                cwd: request.cwd,
                cause: new Error("gh not found"),
              }),
            )
        : Effect.succeed(processResult(input.ghAuthStatus ?? '{"hosts":{}}')),
  });
  const settings = ServerSettings.ServerSettingsService.layerTest({
    github: {
      hosts: input.hosts ?? {},
      tokens: input.tokens ?? {},
    },
  });
  return GitHubSourceControlProvider.makeDiscovery.pipe(
    Effect.flatMap((discovery) => discovery.probe("/repo")),
    Effect.provide(
      Layer.mergeAll(
        settings,
        process,
        Layer.mock(GitHubApi.GitHubApi)({ rest: ({ host }) => input.rest(host) }),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, input.environment ?? {}),
  );
}

it.effect("maps GitHub PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add GitHub provider",
          url: "https://github.com/supabitapp/supacode-next/pull/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/supacode",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "github",
      number: 42,
      title: "Add GitHub provider",
      url: "https://github.com/supabitapp/supacode-next/pull/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      closedAt: null,
      mergedAt: null,
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/supacode",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds safe request context while retaining GitHub API causes", () =>
  Effect.gen(function* () {
    const cause = new GitHubRepositoryApi.GitHubPullRequestNotFoundError({
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference:
          "https://user:secret@github.com/supabitapp/supacode-next/pull/42?token=secret#diff",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "github",
        operation: "getChangeRequest",
        cwd: "/repo",
        reference: "https://github.com/supabitapp/supacode-next/pull/42",
        detail: "Pull request not found. Check the PR number or URL and try again.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("lists change request history through the batched head lookup", () =>
  Effect.gen(function* () {
    let lookup:
      | Parameters<GitHubRepositoryApi.GitHubRepositoryApi["Service"]["listPullRequestsByHead"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      listPullRequestsByHead: (input) => {
        lookup = input;
        return Effect.succeed([
          {
            number: 7,
            title: "Merged work",
            url: "https://enterprise.test/acme/web/pull/7",
            baseRefName: "main",
            headRefName: "feature/merged",
            headSha: "a".repeat(40),
            state: "merged",
            mergedAt: "2026-01-01T00:00:00Z",
            updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
          },
        ]);
      },
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      context: {
        provider: { kind: "github", name: "GitHub Enterprise", baseUrl: "https://enterprise.test" },
        remoteName: "origin",
        remoteUrl: "https://enterprise.test/acme/web.git",
      },
      headSelector: "feature/merged",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(lookup, {
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "all",
      limit: 10,
      rateLimitHost: "enterprise.test",
    });
    assert.strictEqual(changeRequests[0]?.provider, "github");
    assert.strictEqual(changeRequests[0]?.state, "merged");
    assert.strictEqual(changeRequests[0]?.headSha, "a".repeat(40));
    assert.strictEqual(changeRequests[0]?.mergedAt, "2026-01-01T00:00:00Z");
    assert.deepStrictEqual(
      changeRequests[0]?.updatedAt,
      Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    );
  }),
);

it.effect("creates GitHub PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput:
      | Parameters<GitHubRepositoryApi.GitHubRepositoryApi["Service"]["createPullRequest"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it("accepts active authenticated GitHub accounts when another account fails", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth JSON from stdout when stderr has warnings", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
      { stderr: "warning: ignored diagnostic from gh\n" },
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth status accounts by host and active state", () => {
  assert.deepStrictEqual(
    parseGitHubAuthStatus(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
          "github.example.test": [
            {
              state: "success",
              active: false,
              host: "github.example.test",
              login: "enterprise-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
    ).accounts,
    [
      {
        host: "github.com",
        account: "active-user",
        authenticated: true,
        active: true,
        error: null,
        environmentVariable: null,
      },
      {
        host: "github.com",
        account: "stale-user",
        authenticated: false,
        active: false,
        error: null,
        environmentVariable: null,
      },
      {
        host: "github.example.test",
        account: "enterprise-user",
        authenticated: true,
        active: false,
        error: null,
        environmentVariable: null,
      },
    ],
  );
});

it("reports unauthenticated when GitHub JSON has accounts but none are valid", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "error",
              active: true,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      host: auth.host,
      detail: auth.detail,
    },
    {
      status: "unauthenticated",
      host: Option.some("github.com"),
      detail: Option.some("The token in keyring is invalid."),
    },
  );
});

it("reports an update hint instead of unauthenticated when gh predates --json", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult("", {
      stderr: "unknown flag: --json\n\nUsage:  gh auth status [flags]\n",
      exitCode: ChildProcessSpawner.ExitCode(1),
    }),
  );

  assert.strictEqual(auth.status, "unknown");
  assert.match(
    Option.getOrElse(auth.detail, () => ""),
    /2\.81\.0/,
  );
});

it.effect.each(["pull", "issues"])(
  "resolves %s subjects on the linked host without using the checkout",
  (kind) =>
    Effect.gen(function* () {
      const provider = yield* makeProvider(
        {},
        {
          rest: (input) => {
            assert.strictEqual(input.host, "github.com");
            assert.strictEqual(input.path, "repos/owner/repo/issues/42");
            return Effect.succeed(
              restResponse(
                encodeJson({ title: "Pairing expiry", body: "Preserve remote access", id: 1 }),
              ),
            );
          },
        },
      );
      const lookup = provider.resolveLink?.({
        cwd: "/unrelated",
        url: new URL(`https://github.com/owner/repo/${kind}/42`),
      });
      assert.ok(lookup);
      assert.deepStrictEqual(yield* lookup, {
        title: "Pairing expiry",
        body: "Preserve remote access",
      });
      assert.strictEqual(
        provider.resolveLink?.({
          cwd: "/unrelated",
          url: new URL("https://github.com/owner/repo"),
        }),
        undefined,
      );
    }),
);

it.effect.each(["read", "decode"] as const)(
  "retains the %s failure without exposing its raw contents",
  (stage) =>
    Effect.gen(function* () {
      const cause = new GitHubApi.GitHubApiResponseError({
        host: "github.com",
        operation: "resolveLink",
        status: 500,
      });
      const provider = yield* makeProvider(
        {},
        {
          rest: () =>
            stage === "read"
              ? Effect.fail(cause)
              : Effect.succeed(restResponse("private response text")),
        },
      );
      const lookup = provider.resolveLink?.({
        cwd: "/repo",
        url: new URL("https://github.com/owner/repo/issues/42"),
      });
      assert.ok(lookup);
      const error = yield* Effect.flip(lookup);
      assert.strictEqual(error.operation, stage === "read" ? "resolveLink" : "resolveLink.decode");
      assert.strictEqual(error.detail, "The linked subject could not be read.");
      assert.notInclude(error.message, "private response text");
      if (stage === "read") assert.strictEqual(error.cause, cause);
      else assert.propertyVal(error.cause, "_tag", "SchemaError");
    }),
);

const multiAccountStatus = (extra: ReadonlyArray<Record<string, unknown>> = []) =>
  processResult(
    JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: true, host: "github.com", login: "personal" },
          { state: "success", active: false, host: "github.com", login: "work" },
          ...extra,
        ],
        "ghe.acme.test": [
          { state: "error", active: true, host: "ghe.acme.test", login: "jm", error: "expired" },
        ],
      },
    }),
  );

it("reports every gh login and leads with the account Settings pin", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { account: "work", enabled: true } },
    tokens: {},
  });
  assert.deepStrictEqual(auth.account, Option.some("work"));
  assert.deepStrictEqual(auth.accounts, [
    { host: "github.com", account: "personal", active: true, authenticated: true },
    { host: "github.com", account: "work", active: false, authenticated: true },
    { host: "ghe.acme.test", account: "jm", active: true, authenticated: false, error: "expired" },
  ]);
});

it("falls back to gh's active login when the pinned account is gone", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { account: "former-job", enabled: true } },
    tokens: {},
  });
  assert.deepStrictEqual(auth.account, Option.some("personal"));
});

it("reports unauthenticated when Settings turn off every signed-in host", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { enabled: false } },
    tokens: {},
  });
  assert.strictEqual(auth.status, "unauthenticated");
  assert.deepStrictEqual(
    auth.detail,
    Option.some("Every GitHub host gh is signed in to is turned off in Settings → Source Control."),
  );
});

it("names the environment token that overrides the Settings choice", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(
    multiAccountStatus([
      {
        state: "success",
        active: false,
        host: "github.com",
        login: "bot",
        tokenSource: "GH_TOKEN",
      },
    ]),
    { hosts: { "github.com": { account: "work", enabled: true } }, tokens: {} },
  );
  assert.deepStrictEqual(auth.account, Option.some("bot"));
  assert.deepStrictEqual(
    auth.detail,
    Option.some(
      "Using GH_TOKEN from the server environment; it overrides the account chosen in Settings.",
    ),
  );
  assert.strictEqual(auth.accounts?.[2]?.environmentVariable, "GH_TOKEN");
});

it.effect("discovers an enabled saved GHES token without the GitHub CLI", () => {
  const hosts: string[] = [];
  return Effect.gen(function* () {
    const item = yield* probeGitHubDiscovery({
      tokens: { "ghe.acme.test": "saved-token" },
      rest: (host) => {
        hosts.push(host);
        return Effect.succeed(restResponse('{"login":"enterprise-user"}'));
      },
    });

    assert.strictEqual(item.status, "available");
    assert.deepStrictEqual(item.auth.account, Option.some("enterprise-user"));
    assert.deepStrictEqual(item.auth.host, Option.some("ghe.acme.test"));
    assert.deepStrictEqual(hosts, ["ghe.acme.test"]);
  });
});

it.effect("discovers a GHES environment token only for the configured GH_HOST", () => {
  const hosts: string[] = [];
  return Effect.gen(function* () {
    const item = yield* probeGitHubDiscovery({
      environment: {
        GH_HOST: "ghe.acme.test",
        GH_ENTERPRISE_TOKEN: "enterprise-env-token",
      },
      rest: (host) => {
        hosts.push(host);
        return Effect.succeed(restResponse('{"login":"enterprise-user"}'));
      },
    });

    assert.strictEqual(item.status, "available");
    assert.deepStrictEqual(item.auth.account, Option.some("enterprise-user"));
    assert.deepStrictEqual(item.auth.host, Option.some("ghe.acme.test"));
    assert.deepStrictEqual(
      item.auth.detail,
      Option.some(
        "Using GH_ENTERPRISE_TOKEN from the server environment; it overrides the account chosen in Settings.",
      ),
    );
    assert.deepStrictEqual(hosts, ["ghe.acme.test"]);
  });
});

it.effect("reports an invalid saved token for its own host", () => {
  const hosts: string[] = [];
  return Effect.gen(function* () {
    const item = yield* probeGitHubDiscovery({
      ghAvailable: true,
      ghAuthStatus: JSON.stringify({
        hosts: {
          "ghe.acme.test": [
            { state: "success", active: true, host: "ghe.acme.test", login: "cli-user" },
          ],
        },
      }),
      tokens: { "ghe.acme.test": "bad-token" },
      rest: (host) => {
        hosts.push(host);
        return Effect.fail(
          new GitHubApi.GitHubApiAuthenticationError({ host, operation: "discovery" }),
        );
      },
    });

    assert.strictEqual(item.status, "available");
    assert.strictEqual(item.auth.status, "unauthenticated");
    assert.deepStrictEqual(item.auth.host, Option.some("ghe.acme.test"));
    assert.deepStrictEqual(item.auth.accounts, [
      {
        host: "ghe.acme.test",
        account: "cli-user",
        active: true,
        authenticated: true,
      },
    ]);
    assert.deepStrictEqual(hosts, ["ghe.acme.test"]);
  });
});

it.effect.each(["invalid", "network"] as const)(
  "keeps valid CLI auth for a different host after a GHES %s failure",
  (failure) => {
    const hosts: string[] = [];
    return Effect.gen(function* () {
      const item = yield* probeGitHubDiscovery({
        ghAvailable: true,
        ghAuthStatus: JSON.stringify({
          hosts: {
            "github.com": [
              { state: "success", active: true, host: "github.com", login: "cli-user" },
            ],
          },
        }),
        tokens: { "ghe.acme.test": "enterprise-token" },
        rest: (host) => {
          hosts.push(host);
          return failure === "invalid"
            ? Effect.fail(
                new GitHubApi.GitHubApiAuthenticationError({ host, operation: "discovery" }),
              )
            : Effect.fail(
                new GitHubApi.GitHubApiRequestError({
                  host,
                  operation: "discovery",
                  cause: new Error("network unavailable"),
                }),
              );
        },
      });

      assert.strictEqual(item.status, "available");
      assert.strictEqual(item.auth.status, "authenticated");
      assert.deepStrictEqual(item.auth.account, Option.some("cli-user"));
      assert.deepStrictEqual(item.auth.host, Option.some("github.com"));
      assert.deepStrictEqual(item.auth.accounts, [
        {
          host: "github.com",
          account: "cli-user",
          active: true,
          authenticated: true,
        },
      ]);
      assert.deepStrictEqual(hosts, ["ghe.acme.test"]);
    });
  },
);

it.effect("uses a valid enabled saved host after another host refuses its token", () => {
  const hosts: string[] = [];
  return Effect.gen(function* () {
    const item = yield* probeGitHubDiscovery({
      ghAvailable: true,
      ghAuthStatus: JSON.stringify({
        hosts: {
          "github.com": [{ state: "success", active: true, host: "github.com", login: "cli-user" }],
        },
      }),
      hosts: { "ghe.disabled.test": { enabled: false } },
      tokens: {
        "github.com": "bad-dotcom-token",
        "ghe.acme.test": "valid-enterprise-token",
        "ghe.disabled.test": "disabled-token",
      },
      rest: (host) => {
        hosts.push(host);
        return host === "github.com"
          ? Effect.fail(
              new GitHubApi.GitHubApiAuthenticationError({ host, operation: "discovery" }),
            )
          : Effect.succeed(restResponse('{"login":"enterprise-user"}'));
      },
    });

    assert.strictEqual(item.status, "available");
    assert.strictEqual(item.auth.status, "authenticated");
    assert.deepStrictEqual(item.auth.account, Option.some("enterprise-user"));
    assert.deepStrictEqual(item.auth.host, Option.some("ghe.acme.test"));
    assert.deepStrictEqual(item.auth.accounts, [
      {
        host: "github.com",
        account: "cli-user",
        active: true,
        authenticated: true,
      },
    ]);
    assert.deepStrictEqual(hosts, ["github.com", "ghe.acme.test"]);
  });
});

it.effect("does not probe saved or environment tokens for a disabled host", () => {
  const hosts: string[] = [];
  return Effect.gen(function* () {
    const item = yield* probeGitHubDiscovery({
      hosts: { "ghe.acme.test": { enabled: false } },
      tokens: { "ghe.acme.test": "disabled-token" },
      environment: {
        GH_HOST: "ghe.acme.test",
        GH_ENTERPRISE_TOKEN: "disabled-env-token",
      },
      rest: (host) => {
        hosts.push(host);
        return Effect.succeed(restResponse('{"login":"should-not-be-used"}'));
      },
    });

    assert.strictEqual(item.status, "missing");
    assert.deepStrictEqual(hosts, []);
  });
});

it.effect("ignores an empty normalized GH_HOST", () => {
  const hosts: string[] = [];
  return Effect.gen(function* () {
    const item = yield* probeGitHubDiscovery({
      environment: { GH_HOST: "   ", GH_ENTERPRISE_TOKEN: "enterprise-env-token" },
      rest: (host) => {
        hosts.push(host);
        return Effect.succeed(restResponse('{"login":"should-not-be-used"}'));
      },
    });

    assert.strictEqual(item.status, "missing");
    assert.deepStrictEqual(hosts, []);
  });
});
