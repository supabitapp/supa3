#!/usr/bin/env node
// Effect has no RSA signing, and expo-updates verifies an RSA signature on every manifest.
import * as NodeCrypto from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  MOBILE_OTA_CURRENT_FILE,
  MOBILE_OTA_REPOSITORY,
  type MobileOtaPlatform,
  type MobileOtaReleaseFile,
  isMobileOtaChannelTag,
  mobileOtaAssetUrl,
  mobileOtaReleaseTag,
} from "./lib/mobile-ota.ts";

// Must match `updates.codeSigningMetadata.keyid` in apps/mobile/app.config.ts.
const SIGNING_KEY_ID = "main";
// A release holds at most 1,000 assets, so old updates are pruned well before that.
const PRUNE_ABOVE_ASSET_COUNT = 800;
const KEEP_UPDATES = 20;
const HISTORY_FILE_PATTERN = /^update-(\d+)-.+\.json$/;
const PR_CHANNEL_PATTERN = /^pr-\d+$/;

const CONTENT_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  webp: "image/webp",
  xml: "application/xml",
};

export class MobileOtaError extends Schema.TaggedError<MobileOtaError>()("MobileOtaError", {
  message: Schema.String,
}) {}

const ManifestAsset = Schema.Struct({
  hash: Schema.String,
  key: Schema.String,
  contentType: Schema.String,
  fileExtension: Schema.String,
  url: Schema.String,
});

export const UpdateManifest = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  runtimeVersion: Schema.String,
  launchAsset: ManifestAsset,
  assets: Schema.Array(ManifestAsset),
  metadata: Schema.Record(Schema.String, Schema.String),
  extra: Schema.Struct({ expoClient: Schema.Unknown }),
});
export type UpdateManifest = typeof UpdateManifest.Type;

const RollBackToEmbeddedDirective = Schema.Struct({
  type: Schema.Literal("rollBackToEmbedded"),
  parameters: Schema.Struct({ commitTime: Schema.String }),
});

const ReleaseFile = Schema.Struct({
  part: Schema.Literals(["manifest", "directive"]),
  body: Schema.String,
  signature: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

const ExportMetadata = Schema.Struct({
  fileMetadata: Schema.Record(
    Schema.String,
    Schema.Struct({
      bundle: Schema.String,
      assets: Schema.Array(Schema.Struct({ path: Schema.String, ext: Schema.String })),
    }),
  ),
});

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(UpdateManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(UpdateManifest));
const encodeDirective = Schema.encodeEffect(Schema.fromJsonString(RollBackToEmbeddedDirective));
const decodeReleaseFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseFile));
const encodeReleaseFile = Schema.encodeEffect(Schema.fromJsonString(ReleaseFile));
const decodeExportMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(ExportMetadata));
const decodeExpoClient = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeReleaseView = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ assets: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  ),
);
const decodeReleaseList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ tagName: Schema.String }))),
);

/** A file from `expo export`, identified by its SHA-256 like expo-updates identifies assets. */
export interface ExportedFile {
  readonly sha256: Uint8Array;
  readonly fileExtension: string;
  readonly contentType: string;
}

/** Content-addressed, so every update of a runtime reuses the files it did not change. */
export function releaseAssetName(file: ExportedFile): string {
  return `${Encoding.encodeHex(file.sha256)}${file.fileExtension}`;
}

function manifestAsset(tag: string, file: ExportedFile) {
  return {
    hash: Encoding.encodeBase64Url(file.sha256),
    key: Encoding.encodeHex(file.sha256),
    contentType: file.contentType,
    fileExtension: file.fileExtension,
    url: mobileOtaAssetUrl(tag, releaseAssetName(file)),
  };
}

export function updateManifest(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly runtimeVersion: string;
  readonly tag: string;
  readonly launchAsset: ExportedFile;
  readonly assets: ReadonlyArray<ExportedFile>;
  readonly expoClient: unknown;
}): UpdateManifest {
  const assets = new Map(input.assets.map((file) => [releaseAssetName(file), file]));
  return {
    id: input.id,
    createdAt: input.createdAt,
    runtimeVersion: input.runtimeVersion,
    launchAsset: manifestAsset(input.tag, input.launchAsset),
    assets: [...assets.values()].map((file) => manifestAsset(input.tag, file)),
    metadata: {},
    // expo-constants reads `Constants.expoConfig` from here once an update is running.
    extra: { expoClient: input.expoClient },
  };
}

/** `expo-signature` value for `body`, signed with the key behind apps/mobile/certs/certificate.pem. */
export function signatureHeader(body: string, privateKeyPem: string): string {
  const signature = NodeCrypto.sign("sha256", new TextEncoder().encode(body), privateKeyPem);
  return `sig="${Encoding.encodeBase64(signature)}", keyid="${SIGNING_KEY_ID}"`;
}

export function historyFileName(createdAt: DateTime.DateTime, label: string): string {
  return `update-${DateTime.toEpochMillis(createdAt)}-${label}.json`;
}

/** Splits history files into the newest `keep` and the rest. */
export function planHistoryPrune(
  assetNames: ReadonlyArray<string>,
  keep: number,
): { readonly kept: ReadonlyArray<string>; readonly stale: ReadonlyArray<string> } {
  const history = assetNames
    .flatMap((name) => {
      const publishedAt = HISTORY_FILE_PATTERN.exec(name)?.[1];
      return publishedAt === undefined ? [] : [{ name, publishedAt: Number(publishedAt) }];
    })
    .toSorted((a, b) => b.publishedAt - a.publishedAt)
    .map(({ name }) => name);
  return { kept: history.slice(0, keep), stale: history.slice(keep) };
}

/** Bundles and assets that none of the kept updates reference. */
export function unreferencedAssets(
  assetNames: ReadonlyArray<string>,
  keptManifests: ReadonlyArray<UpdateManifest>,
): ReadonlyArray<string> {
  const referenced = new Set(
    keptManifests.flatMap((manifest) =>
      [manifest.launchAsset, ...manifest.assets].map((asset) =>
        asset.url.slice(asset.url.lastIndexOf("/") + 1),
      ),
    ),
  );
  return assetNames.filter(
    (name) =>
      name !== MOBILE_OTA_CURRENT_FILE && !HISTORY_FILE_PATTERN.test(name) && !referenced.has(name),
  );
}

const run = Effect.fn("mobileOta.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly inherit?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = options.inherit ? "inherit" : "pipe";
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: output,
      stderr: output,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const runOrFail = Effect.fn("mobileOta.runOrFail")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly inherit?: boolean },
) {
  const result = yield* run(command, args, options);
  if (result.exitCode !== 0) {
    return yield* new MobileOtaError({
      message: `${command} ${args.slice(0, 2).join(" ")} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    });
  }
  return result.stdout;
});

const gh = (args: ReadonlyArray<string>) =>
  runOrFail("gh", [...args, "--repo", MOBILE_OTA_REPOSITORY]);

const releaseAssetNames = Effect.fn("mobileOta.releaseAssetNames")(function* (tag: string) {
  const result = yield* run("gh", [
    "release",
    "view",
    tag,
    "--repo",
    MOBILE_OTA_REPOSITORY,
    "--json",
    "assets",
  ]);
  if (result.exitCode !== 0) {
    if (result.stderr.includes("release not found")) return Option.none<ReadonlyArray<string>>();
    return yield* new MobileOtaError({
      message: `Could not read release ${tag}: ${result.stderr.trim()}`,
    });
  }
  const view = yield* decodeReleaseView(result.stdout);
  return Option.some(view.assets.map((asset) => asset.name));
});

const ensureRelease = Effect.fn("mobileOta.ensureRelease")(function* (tag: string) {
  const existing = yield* releaseAssetNames(tag);
  if (Option.isSome(existing)) return existing.value;
  yield* gh([
    "release",
    "create",
    tag,
    "--title",
    tag,
    "--notes",
    "Signed expo-updates release published by scripts/mobile-ota.ts in supabitapp/supacode-next.",
    "--latest=false",
  ]);
  return [];
});

const releaseTag = Effect.fn("mobileOta.releaseTag")(function* (
  channel: string,
  platform: MobileOtaPlatform,
  runtimeVersion: string,
) {
  const tag = mobileOtaReleaseTag(channel, platform, runtimeVersion);
  if (tag === undefined) {
    return yield* new MobileOtaError({
      message: `Unsupported channel "${channel}" or runtime version "${runtimeVersion}".`,
    });
  }
  return tag;
});

const SigningKey = Config.Redacted("MOBILE_OTA_SIGNING_KEY");

const downloadReleaseFile = Effect.fn("mobileOta.downloadReleaseFile")(function* (
  tag: string,
  name: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* gh(["release", "download", tag, "--pattern", name, "--dir", directory, "--clobber"]);
  return yield* decodeReleaseFile(yield* fs.readFileString(path.join(directory, name)));
});

/** Uploads a signed update or directive and makes it the one the Worker serves. */
const publishReleaseFile = Effect.fn("mobileOta.publishReleaseFile")(function* (
  tag: string,
  stageDirectory: string,
  historyName: string,
  file: MobileOtaReleaseFile,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* encodeReleaseFile(file);
  const historyPath = path.join(stageDirectory, historyName);
  const currentPath = path.join(stageDirectory, MOBILE_OTA_CURRENT_FILE);
  yield* fs.writeFileString(historyPath, contents);
  yield* fs.writeFileString(currentPath, contents);
  // History goes first, so the served update can always be found again for a rollback.
  yield* gh(["release", "upload", tag, historyPath]);
  yield* gh(["release", "upload", tag, currentPath, "--clobber"]);
});

const pruneRelease = Effect.fn("mobileOta.pruneRelease")(function* (
  tag: string,
  stageDirectory: string,
) {
  const assetNames = Option.getOrElse(yield* releaseAssetNames(tag), () => []);
  if (assetNames.length <= PRUNE_ABOVE_ASSET_COUNT) return;
  const { kept, stale } = planHistoryPrune(assetNames, KEEP_UPDATES);
  const keptFiles = yield* Effect.forEach(kept, (name) =>
    downloadReleaseFile(tag, name, stageDirectory),
  );
  const keptManifests = yield* Effect.forEach(
    keptFiles.filter((file) => file.part === "manifest"),
    (file) => decodeManifest(file.body),
  );
  const removed = [...stale, ...unreferencedAssets(assetNames, keptManifests)];
  yield* Effect.forEach(removed, (name) => gh(["release", "delete-asset", tag, name, "--yes"]), {
    discard: true,
  });
  yield* Console.log(`Pruned ${removed.length} files from ${tag}.`);
});

const exportedFile = Effect.fn("mobileOta.exportedFile")(function* (
  exportDirectory: string,
  uploadDirectory: string,
  relativePath: string,
  fileExtension: string,
  contentType: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const source = path.join(exportDirectory, relativePath);
  const file: ExportedFile = {
    sha256: yield* crypto.digest("SHA-256", yield* fs.readFile(source)),
    fileExtension,
    contentType,
  };
  yield* fs.copyFile(source, path.join(uploadDirectory, releaseAssetName(file)));
  return file;
});

const publish = Effect.fn("mobileOta.publish")(function* (input: {
  readonly platform: MobileOtaPlatform;
  readonly channel: string;
  readonly runtimeVersion: string;
  readonly message: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tag = yield* releaseTag(input.channel, input.platform, input.runtimeVersion);
  const privateKey = Redacted.value(yield* SigningKey);
  const mobileDirectory = yield* path.fromFileUrl(new URL("../apps/mobile", import.meta.url));
  const stageDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "supacode-mobile-ota-" });
  const exportDirectory = path.join(stageDirectory, "export");
  const uploadDirectory = path.join(stageDirectory, "upload");
  yield* fs.makeDirectory(uploadDirectory);

  yield* runOrFail(
    "npx",
    ["expo", "export", "--platform", input.platform, "--output-dir", exportDirectory],
    { cwd: mobileDirectory, inherit: true },
  );
  const expoClient = yield* decodeExpoClient(
    yield* runOrFail("npx", ["expo", "config", "--type", "public", "--json"], {
      cwd: mobileDirectory,
    }),
  );
  const metadata = yield* decodeExportMetadata(
    yield* fs.readFileString(path.join(exportDirectory, "metadata.json")),
  );
  const exported = metadata.fileMetadata[input.platform];
  if (exported === undefined) {
    return yield* new MobileOtaError({
      message: `expo export produced no ${input.platform} bundle.`,
    });
  }
  const launchAsset = yield* exportedFile(
    exportDirectory,
    uploadDirectory,
    exported.bundle,
    ".bundle",
    "application/javascript",
  );
  const assets = yield* Effect.forEach(exported.assets, (asset) =>
    exportedFile(
      exportDirectory,
      uploadDirectory,
      asset.path,
      `.${asset.ext}`,
      CONTENT_TYPES[asset.ext] ?? "application/octet-stream",
    ),
  );

  const createdAt = yield* DateTime.now;
  const id = yield* crypto.randomUUIDv4;
  const body = yield* encodeManifest(
    updateManifest({
      id,
      createdAt: DateTime.formatIso(createdAt),
      runtimeVersion: input.runtimeVersion,
      tag,
      launchAsset,
      assets,
      expoClient,
    }),
  );

  const existing = new Set(yield* ensureRelease(tag));
  const uploads = (yield* fs.readDirectory(uploadDirectory)).filter((name) => !existing.has(name));
  if (uploads.length > 0) {
    yield* gh([
      "release",
      "upload",
      tag,
      ...uploads.map((name) => path.join(uploadDirectory, name)),
    ]);
  }
  yield* publishReleaseFile(tag, stageDirectory, historyFileName(createdAt, id), {
    part: "manifest",
    body,
    signature: signatureHeader(body, privateKey),
    ...Option.match(input.message, { onNone: () => ({}), onSome: (message) => ({ message }) }),
  });
  yield* pruneRelease(tag, stageDirectory);
  yield* Console.log(`Published update ${id} to ${tag} with ${uploads.length} new files.`);
}, Effect.scoped);

const rollback = Effect.fn("mobileOta.rollback")(function* (input: {
  readonly platform: MobileOtaPlatform;
  readonly channel: string;
  readonly runtimeVersion: string;
  readonly updateId: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const tag = yield* releaseTag(input.channel, input.platform, input.runtimeVersion);
  const privateKey = Redacted.value(yield* SigningKey);
  const existing = yield* releaseAssetNames(tag);
  if (Option.isNone(existing)) {
    return yield* new MobileOtaError({ message: `Nothing was published to ${tag}.` });
  }
  const stageDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "supacode-mobile-ota-" });
  const createdAt = yield* DateTime.now;

  if (Option.isNone(input.updateId)) {
    const body = yield* encodeDirective({
      type: "rollBackToEmbedded",
      parameters: { commitTime: DateTime.formatIso(createdAt) },
    });
    yield* publishReleaseFile(tag, stageDirectory, historyFileName(createdAt, "embedded"), {
      part: "directive",
      body,
      signature: signatureHeader(body, privateKey),
      message: "Roll back to the update embedded in the binary",
    });
    yield* Console.log(`${tag} now rolls devices back to their embedded update.`);
    return;
  }

  const updateId = input.updateId.value;
  const historyName = existing.value.find(
    (name) => HISTORY_FILE_PATTERN.test(name) && name.endsWith(`-${updateId}.json`),
  );
  if (historyName === undefined) {
    return yield* new MobileOtaError({ message: `${tag} has no update ${updateId}.` });
  }
  const previous = yield* downloadReleaseFile(tag, historyName, stageDirectory);
  const manifest = yield* decodeManifest(previous.body);
  // Devices only take updates newer than the one they run, so the old update ships as a new one.
  const id = yield* crypto.randomUUIDv4;
  const body = yield* encodeManifest({ ...manifest, id, createdAt: DateTime.formatIso(createdAt) });
  yield* publishReleaseFile(tag, stageDirectory, historyFileName(createdAt, id), {
    part: "manifest",
    body,
    signature: signatureHeader(body, privateKey),
    message: `Republish ${updateId}`,
  });
  yield* Console.log(`Republished update ${updateId} to ${tag} as ${id}.`);
}, Effect.scoped);

const deleteChannel = Effect.fn("mobileOta.deleteChannel")(function* (channel: string) {
  if (!PR_CHANNEL_PATTERN.test(channel)) {
    return yield* new MobileOtaError({
      message: `Only PR channels can be deleted, not "${channel}".`,
    });
  }
  const releases = yield* decodeReleaseList(
    yield* gh(["release", "list", "--limit", "1000", "--json", "tagName"]),
  );
  const tags = releases
    .map((release) => release.tagName)
    .filter((tag) => isMobileOtaChannelTag(tag, channel));
  yield* Effect.forEach(tags, (tag) => gh(["release", "delete", tag, "--yes", "--cleanup-tag"]), {
    discard: true,
  });
  yield* Console.log(`Deleted ${tags.length} releases for ${channel}.`);
});

const platformFlag = Flag.Literals("platform", ["ios", "android"]).pipe(
  Flag.withDescription("Native platform the update targets."),
);
const channelFlag = Flag.String("channel").pipe(
  Flag.withDescription("Update channel, such as production or pr-123."),
);
const runtimeVersionFlag = Flag.String("runtime-version").pipe(
  Flag.withDescription("Runtime version (native fingerprint) of the binaries to update."),
);

const publishCommand = Command.make(
  "publish",
  {
    platform: platformFlag,
    channel: channelFlag,
    runtimeVersion: runtimeVersionFlag,
    message: Flag.String("message").pipe(
      Flag.withDescription("Description stored with the update."),
      Flag.optional,
    ),
  },
  publish,
).pipe(Command.withDescription("Export, sign, and publish an update to its GitHub release."));

const rollbackCommand = Command.make(
  "rollback",
  {
    platform: platformFlag,
    channel: channelFlag,
    runtimeVersion: runtimeVersionFlag,
    updateId: Flag.String("update-id").pipe(
      Flag.withDescription(
        "Republish this earlier update. Omit to roll back to the embedded update.",
      ),
      Flag.optional,
    ),
  },
  rollback,
).pipe(Command.withDescription("Serve an earlier update, or the binary's embedded update, again."));

const deleteChannelCommand = Command.make(
  "delete-channel",
  { channel: channelFlag },
  ({ channel }) => deleteChannel(channel),
).pipe(Command.withDescription("Delete every release of a PR channel."));

export const mobileOtaCommand = Command.make("mobile-ota").pipe(
  Command.withDescription(`Publish self-hosted expo-updates releases to ${MOBILE_OTA_REPOSITORY}.`),
  Command.withSubcommands([publishCommand, rollbackCommand, deleteChannelCommand]),
);

if (import.meta.main) {
  Command.run(mobileOtaCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
