const { execFileSync } = require("node:child_process");

function fingerprintEntry(entries, platform) {
  const pattern =
    platform === "ios"
      ? /^Payload\/[^/]+\.app\/EXUpdates\.bundle\/fingerprint$/
      : /^(base\/)?assets\/fingerprint$/;
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${platform} fingerprint, found ${matches.length}`);
  }
  return matches[0];
}

function readFingerprint(binary, platform) {
  if (platform !== "ios" && platform !== "android") {
    throw new Error(`Unsupported mobile platform: ${platform}`);
  }
  const entries = execFileSync("unzip", ["-Z1", binary], { encoding: "utf8" }).split("\n");
  const fingerprint = execFileSync("unzip", ["-p", binary, fingerprintEntry(entries, platform)], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(fingerprint)) {
    throw new Error("The binary does not contain a valid native fingerprint");
  }
  return fingerprint;
}

module.exports = { fingerprintEntry, readFingerprint };

if (require.main === module) {
  console.log(readFingerprint(process.argv[2], process.argv[3]));
}
