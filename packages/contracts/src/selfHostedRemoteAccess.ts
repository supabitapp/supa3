import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SelfHostedRemoteAccessStatus = Schema.Struct({
  state: Schema.Literals([
    "unconfigured",
    "disabled",
    "connecting",
    "connected",
    "needs-login",
    "error",
    "cleanup-pending",
    "relay-mode",
  ]),
  enabled: Schema.Boolean,
  ready: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  publicUrl: Schema.NullOr(TrimmedNonEmptyString),
  accountId: Schema.NullOr(TrimmedNonEmptyString),
  zoneName: Schema.NullOr(TrimmedNonEmptyString),
  failure: Schema.NullOr(
    Schema.Literals([
      "login-required",
      "provision-failed",
      "connector-failed",
      "endpoint-unavailable",
      "cleanup-failed",
    ]),
  ),
});
export type SelfHostedRemoteAccessStatus = typeof SelfHostedRemoteAccessStatus.Type;

export const SelfHostedRemoteAccessConfigureInput = Schema.Struct({
  certificatePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SelfHostedRemoteAccessConfigureInput = typeof SelfHostedRemoteAccessConfigureInput.Type;

export const SelfHostedRemoteAccessSetEnabledInput = Schema.Struct({ enabled: Schema.Boolean });
export const SelfHostedRemoteAccessSetup = Schema.Struct({ prompt: TrimmedNonEmptyString });

export class SelfHostedRemoteAccessError extends Schema.TaggedError<SelfHostedRemoteAccessError>()(
  "SelfHostedRemoteAccessError",
  {
    reason: Schema.Literals([
      "login-required",
      "account-mismatch",
      "not-configured",
      "relay-mode",
      "cleanup-pending",
      "unsupported-binding",
      "operation-failed",
    ]),
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    switch (this.reason) {
      case "login-required":
        return "Sign in to Cloudflare on this environment, then repair remote access.";
      case "account-mismatch":
        return "The Cloudflare login belongs to another account or domain. Restore the original login or remove this installation first.";
      case "not-configured":
        return "Set up remote access before enabling it.";
      case "relay-mode":
        return "This environment uses an account relay. Disable relay mode before setting up a self-owned endpoint.";
      case "cleanup-pending":
        return "Finish removing the previous installation before setting up another.";
      case "unsupported-binding":
        return "This host must listen on loopback or all interfaces to use the tunnel. Restart it with that binding, then repair remote access.";
      case "operation-failed":
        return "Remote access could not complete the operation. Repair or retry it from Connections.";
    }
  }
}
