import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const RESERVE_RATIO = 0.1;

type GitHubQuotaResource = string;

interface QuotaSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

export class GitHubQuotaPausedError extends Schema.TaggedError<GitHubQuotaPausedError>()(
  "GitHubQuotaPausedError",
  { host: Schema.String, resource: Schema.String, retryAt: Schema.Finite },
) {
  override get message(): string {
    return `GitHub requests to ${this.host} are paused until the rate limit resets.`;
  }
}

export const isGitHubQuotaPausedError = Schema.is(Schema.Struct(GitHubQuotaPausedError.fields));

function quotaFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): (QuotaSnapshot & { readonly resource: GitHubQuotaResource }) | null {
  const resource = headers["x-ratelimit-resource"]?.trim();
  const limit = Number(headers["x-ratelimit-limit"]);
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (
    !resource ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    !Number.isFinite(reset)
  ) {
    return null;
  }
  return { resource, limit, remaining, resetAtMs: reset * 1_000 };
}

export class GitHubQuota extends Context.Service<
  GitHubQuota,
  {
    readonly admit: (
      host: string,
      resource: GitHubQuotaResource,
      options?: { readonly allowReserve: boolean },
    ) => Effect.Effect<void, GitHubQuotaPausedError>;
    readonly observe: (
      host: string,
      headers: Readonly<Record<string, string | undefined>>,
    ) => Effect.Effect<void>;
  }
>()("supacode/sourceControl/githubQuota") {}

const make = Effect.gen(function* () {
  const snapshots = yield* Ref.make<ReadonlyMap<string, QuotaSnapshot>>(new Map());
  const keyOf = (host: string, resource: string, scope: string) =>
    `${host.trim().toLowerCase()}\0${resource}\0${scope}`;

  const admit: GitHubQuota["Service"]["admit"] = Effect.fn("GitHubQuota.admit")(
    function* (host, resource, options) {
      const now = yield* Clock.currentTimeMillis;
      const key = keyOf(host, resource, yield* SourceControlRateLimit.CredentialScope);
      const snapshot = (yield* Ref.get(snapshots)).get(key);
      if (snapshot === undefined || snapshot.resetAtMs <= now) return;
      const floor = options?.allowReserve === true ? 1 : snapshot.limit * RESERVE_RATIO;
      if (snapshot.remaining >= floor) return;
      return yield* new GitHubQuotaPausedError({
        host: host.trim().toLowerCase(),
        resource,
        retryAt: snapshot.resetAtMs,
      });
    },
  );

  const observe: GitHubQuota["Service"]["observe"] = Effect.fn("GitHubQuota.observe")(
    function* (host, headers) {
      const quota = quotaFromHeaders(headers);
      if (quota === null) return;
      const key = keyOf(host, quota.resource, yield* SourceControlRateLimit.CredentialScope);
      yield* Ref.update(snapshots, (current) => {
        const previous = current.get(key);

        if (previous !== undefined && quota.resetAtMs < previous.resetAtMs) return current;
        const next = new Map(current);
        next.set(key, {
          limit: quota.limit,
          remaining: quota.remaining,
          resetAtMs: quota.resetAtMs,
        });
        return next;
      });
    },
  );

  return GitHubQuota.of({ admit, observe });
});

export const layer = Layer.effect(GitHubQuota, make);
