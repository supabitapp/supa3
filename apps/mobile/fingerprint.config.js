// @ts-check
// Advance this generation when a release must reach users through a new store
// binary. Calendar year changes share OTAs when the native fingerprint matches.
// This generation also keeps legacy 2.x binaries on their original OTA runtime.
module.exports = {
  extraSources: [{ type: "contents", id: "appUpdateGeneration", contents: "calendar-1" }],
};
