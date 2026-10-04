const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fingerprintEntry, readFingerprint } = require("./mobile-build-fingerprint.cjs");

for (const [platform, entry, extension] of [
  ["ios", "Payload/Supacode.app/EXUpdates.bundle/fingerprint", "ipa"],
  ["android", "assets/fingerprint", "apk"],
  ["android", "base/assets/fingerprint", "aab"],
]) {
  test(`reads the fingerprint embedded in a ${extension} archive`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-fingerprint-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, entry);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "a".repeat(40));
    const binary = path.join(directory, `app.${extension}`);
    execFileSync("zip", ["-q", binary, entry], { cwd: directory });
    assert.equal(readFingerprint(binary, platform), "a".repeat(40));
    fs.writeFileSync(filename, "invalid");
    execFileSync("zip", ["-q", binary, entry], { cwd: directory });
    assert.throws(() => readFingerprint(binary, platform), /valid native fingerprint/);
  });
}

test("rejects missing and ambiguous fingerprints", () => {
  assert.throws(() => fingerprintEntry([], "ios"), /found 0/);
  assert.throws(
    () =>
      fingerprintEntry(
        [
          "Payload/App.app/EXUpdates.bundle/fingerprint",
          "Payload/Other.app/EXUpdates.bundle/fingerprint",
        ],
        "ios",
      ),
    /found 2/,
  );
  assert.throws(() => readFingerprint("app.zip", "web"), /Unsupported/);
});
