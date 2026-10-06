// @effect-diagnostics nodeBuiltinImport:off -- cloudflared stores its login certificate under the operating-system user's home.
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";

const Certificate = Schema.Struct({
  accountID: Schema.NonEmptyString,
  zoneID: Schema.NonEmptyString,
  apiToken: Schema.NonEmptyString,
  endpoint: Schema.optionalKey(Schema.String),
});

const decodeCertificate = Schema.decodeUnknownEffect(Schema.fromJsonString(Certificate));

export class CloudflareLoginRequired extends Schema.TaggedError<CloudflareLoginRequired>()(
  "CloudflareLoginRequired",
  {},
) {
  override get message(): string {
    return "Sign in with `supacode remote login` on this environment, then repair remote access.";
  }
}

export class CloudflareCredentials extends Context.Service<
  CloudflareCredentials,
  {
    readonly defaultCertificatePath: string;
    readonly read: (certificatePath?: string) => Effect.Effect<
      {
        readonly accountId: string;
        readonly zoneId: string;
        readonly token: Redacted.Redacted<string>;
        readonly certificatePath: string;
      },
      CloudflareLoginRequired
    >;
  }
>()("supacode/cloud/CloudflareCredentials") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultCertificatePath = path.join(NodeOS.homedir(), ".cloudflared", "cert.pem");
  const read = Effect.fn("CloudflareCredentials.read")(function* (
    certificatePath = defaultCertificatePath,
  ) {
    const contents = yield* fs
      .readFileString(certificatePath)
      .pipe(Effect.mapError(() => new CloudflareLoginRequired()));
    const blocks = [
      ...contents.matchAll(
        /-----BEGIN ARGO TUNNEL TOKEN-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END ARGO TUNNEL TOKEN-----/g,
      ),
    ];
    if (blocks.length !== 1) return yield* new CloudflareLoginRequired();
    const json = yield* Effect.fromResult(
      Base64.decodeString(blocks[0]![1]!.replace(/\s/g, "")),
    ).pipe(Effect.mapError(() => new CloudflareLoginRequired()));
    // Decode failures intentionally discard their input: it contains a management token.
    const certificate = yield* decodeCertificate(json).pipe(
      Effect.mapError(() => new CloudflareLoginRequired()),
    );
    if (certificate.endpoint && certificate.endpoint !== "production")
      return yield* new CloudflareLoginRequired();
    return {
      accountId: certificate.accountID,
      zoneId: certificate.zoneID,
      token: Redacted.make(certificate.apiToken),
      certificatePath,
    };
  });
  return CloudflareCredentials.of({ defaultCertificatePath, read });
});

export const layer = Layer.effect(CloudflareCredentials, make);
