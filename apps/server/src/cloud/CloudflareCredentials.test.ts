import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Base64 from "effect/encoding/Base64";
import * as Credentials from "./CloudflareCredentials.ts";

const certificate = (value: string) =>
  `-----BEGIN ARGO TUNNEL TOKEN-----\n${Base64.encode(new TextEncoder().encode(value))}\n-----END ARGO TUNNEL TOKEN-----\n`;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("CloudflareCredentials", () => {
  it.effect("reads the official login format without altering the user's certificate", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "cert.pem");
      const contents = certificate(
        '{"accountID":"account","zoneID":"zone","apiToken":"management-secret"}',
      );
      yield* fs.writeFileString(file, contents);
      const credentials = yield* Credentials.make;
      const login = yield* credentials.read(file);
      expect(login.accountId).toBe("account");
      expect(login.zoneId).toBe("zone");
      expect(Redacted.value(login.token)).toBe("management-secret");
      expect(yield* encodeJson(login)).not.toContain("management-secret");
      expect(yield* fs.readFileString(file)).toBe(contents);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reports malformed, missing and unsupported credentials without leaking their contents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(yield* fs.makeTempDirectoryScoped(), "cert.pem");
        const credentials = yield* Credentials.make;
        const missing = yield* credentials.read(file).pipe(Effect.flip);
        expect(missing._tag).toBe("CloudflareLoginRequired");
        for (const contents of [
          "management-secret",
          certificate('{"apiToken":"management-secret"}'),
          certificate(
            '{"accountID":"account","zoneID":"zone","apiToken":"management-secret","endpoint":"fed"}',
          ),
          certificate("management-secret"),
          certificate("{}") + certificate("{}"),
        ]) {
          yield* fs.writeFileString(file, contents);
          const error = yield* credentials.read(file).pipe(Effect.flip);
          expect(error._tag).toBe("CloudflareLoginRequired");
          expect(yield* encodeJson(error)).not.toContain("management-secret");
          expect(error.message).not.toContain("management-secret");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
