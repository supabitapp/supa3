import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Layer from "effect/Layer";
import * as Base64 from "effect/encoding/Base64";
import { ChildProcessSpawner } from "effect/process";
import * as RelayClient from "@supacode/shared/relayClient";
import * as Credentials from "../cloud/CloudflareCredentials.ts";
import { runCloudflareLogin } from "./remote.ts";

const certificate = (token: string) =>
  `-----BEGIN ARGO TUNNEL TOKEN-----\n${Base64.encode(new TextEncoder().encode(`{"accountID":"account","zoneID":"zone","apiToken":"${token}"}`))}\n-----END ARGO TUNNEL TOKEN-----\n`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const file = path.join(directory, "cert.pem");
  const decoder = yield* Credentials.make;
  let spawned = 0;
  const layer = (successful: boolean) =>
    Layer.mergeAll(
      Layer.succeed(Credentials.CloudflareCredentials, {
        defaultCertificatePath: file,
        read: () => decoder.read(file),
      }),
      Layer.succeed(RelayClient.RelayClient, {
        resolve: Effect.die("unused"),
        install: Effect.succeed({
          status: "available" as const,
          executablePath: "cloudflared",
          source: "managed" as const,
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        installWithProgress: () => Effect.die("unused"),
      }),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            spawned++;
            yield* fs.writeFileString(file, certificate("new-login"));
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(successful ? 0 : 1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        ),
      ),
    );
  return { fs, file, directory, layer, spawned: () => spawned };
});
it.effect("reuses a login without spawning or overwriting it; renewal preserves a backup", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.file, certificate("original-login"));
    yield* runCloudflareLogin().pipe(Effect.provide(f.layer(true)));
    expect(f.spawned()).toBe(0);
    expect(yield* f.fs.readFileString(f.file)).toBe(certificate("original-login"));
    yield* runCloudflareLogin(true).pipe(Effect.provide(f.layer(true)));
    expect(f.spawned()).toBe(1);
    expect(yield* f.fs.readFileString(f.file)).toBe(certificate("new-login"));
    const backups = (yield* f.fs.readDirectory(f.directory)).filter((file) =>
      file.includes("supacode-backup"),
    );
    expect(backups).toHaveLength(1);
    expect(yield* f.fs.readFileString(`${f.directory}/${backups[0]}`)).toBe(
      certificate("original-login"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("restores the previous login when renewal fails and retains the failed attempt", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.file, certificate("original-login"));
    yield* runCloudflareLogin(true).pipe(Effect.provide(f.layer(false)), Effect.flip);
    expect(yield* f.fs.readFileString(f.file)).toBe(certificate("original-login"));
    const files = yield* f.fs.readDirectory(f.directory);
    expect(files.some((file) => file.endsWith(".failed-login"))).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
