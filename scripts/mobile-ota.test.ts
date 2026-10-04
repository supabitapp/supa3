import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isMobileOtaChannelTag, mobileOtaReleaseTag } from "./lib/mobile-ota.ts";
import {
  type ExportedFile,
  historyFileName,
  planHistoryPrune,
  signatureHeader,
  unreferencedAssets,
  updateManifest,
} from "./mobile-ota.ts";

function exportedFile(contents: string, fileExtension: string): ExportedFile {
  return {
    sha256: NodeCrypto.createHash("sha256").update(contents).digest(),
    fileExtension,
    contentType: "application/octet-stream",
  };
}

const tag = "ota-production-ios-abc123";

function manifest(...files: ReadonlyArray<ExportedFile>) {
  const [launchAsset, ...assets] = files;
  assert.isDefined(launchAsset);
  return updateManifest({
    id: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-10-04T00:00:00.000Z",
    runtimeVersion: "abc123",
    tag,
    launchAsset,
    assets,
    expoClient: { name: "Supacode" },
  });
}

describe("mobile OTA manifests", () => {
  it("describes each file the way expo-updates verifies downloads", () => {
    const bundle = exportedFile("bundle", ".bundle");
    const { launchAsset } = manifest(bundle);
    const hex = NodeCrypto.createHash("sha256").update("bundle").digest("hex");
    // expo-updates compares against unpadded base64url SHA-256.
    assert.strictEqual(
      launchAsset.hash,
      NodeCrypto.createHash("sha256").update("bundle").digest("base64url"),
    );
    assert.strictEqual(launchAsset.key, hex);
    assert.strictEqual(
      launchAsset.url,
      `https://github.com/supabitapp/supacode-mobile-updates/releases/download/${tag}/${hex}.bundle`,
    );
  });

  it("lists a file shared by several export paths once", () => {
    const icon = exportedFile("icon", ".png");
    assert.lengthOf(manifest(exportedFile("bundle", ".bundle"), icon, icon).assets, 1);
  });

  it("signs the exact manifest bytes with the configured key id", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const body = JSON.stringify(manifest(exportedFile("bundle", ".bundle")));
    const header = signatureHeader(body, privateKey);
    const match = /^sig="([A-Za-z0-9+/=]+)", keyid="main"$/.exec(header);
    assert.isNotNull(match);
    assert.isTrue(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(body),
        publicKey,
        Buffer.from(match?.[1] ?? "", "base64"),
      ),
    );
  });
});

describe("mobile OTA release pruning", () => {
  it("keeps the newest updates by publish time", () => {
    const at = (millis: number) => historyFileName(DateTime.makeUnsafe(millis), `id-${millis}`);
    const { kept, stale } = planHistoryPrune(
      [at(9), "current.json", at(100), "abc.bundle", at(10)],
      2,
    );
    assert.deepStrictEqual(kept, [at(100), at(10)]);
    assert.deepStrictEqual(stale, [at(9)]);
  });

  it("removes only files no kept update references", () => {
    const bundle = exportedFile("bundle", ".bundle");
    const icon = exportedFile("icon", ".png");
    const kept = manifest(bundle, icon);
    const fileName = (url: string) => url.slice(url.lastIndexOf("/") + 1);
    assert.deepStrictEqual(
      unreferencedAssets(
        [
          "current.json",
          "update-1-old.json",
          fileName(kept.launchAsset.url),
          ...kept.assets.map((asset) => fileName(asset.url)),
          "stale.bundle",
        ],
        [kept],
      ),
      ["stale.bundle"],
    );
  });
});

describe("mobile OTA release tags", () => {
  it("rejects channels and runtime versions that cannot be part of a tag", () => {
    assert.strictEqual(mobileOtaReleaseTag("pr-12", "ios", "1a2b"), "ota-pr-12-ios-1a2b");
    assert.isUndefined(mobileOtaReleaseTag("../production", "ios", "1a2b"));
    assert.isUndefined(mobileOtaReleaseTag("production", "android", "1..2"));
  });

  it("matches a channel's releases without catching longer channel names", () => {
    assert.isTrue(isMobileOtaChannelTag("ota-pr-1-android-1a2b", "pr-1"));
    assert.isFalse(isMobileOtaChannelTag("ota-pr-12-android-1a2b", "pr-1"));
    assert.isFalse(isMobileOtaChannelTag("ota-pr-12-android-1a2b", "pr"));
  });
});
