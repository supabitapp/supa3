import { describe, expect, it } from "vite-plus/test";

import { resolveStageArtworkVariant, resolveVisibleStageArtworkVariant } from "./stageArtwork.ts";

describe("stage artwork", () => {
  it("resolves stage artwork per channel", () => {
    expect(resolveStageArtworkVariant("Dev")).toBe("dev");
    expect(resolveStageArtworkVariant("Nightly")).toBe("nightly");
    expect(resolveStageArtworkVariant("Latest")).toBe("release");
    expect(resolveStageArtworkVariant(null)).toBe("release");
    expect(resolveStageArtworkVariant("Preview")).toBeNull();
  });

  it.each(["light", "dark"] as const)("keeps channel artwork under %s themes", (appearance) => {
    expect(resolveVisibleStageArtworkVariant("Nightly", appearance)).toBe("nightly");
    expect(resolveVisibleStageArtworkVariant("Dev", appearance)).toBe("dev");
  });

  it("shows the release sleigh only under dark themes", () => {
    expect(resolveVisibleStageArtworkVariant(null, "dark")).toBe("release");
    expect(resolveVisibleStageArtworkVariant("Latest", "dark")).toBe("release");
    expect(resolveVisibleStageArtworkVariant(null, "light")).toBeNull();
    expect(resolveVisibleStageArtworkVariant("Latest", "light")).toBeNull();
  });

  it.each(["light", "dark"] as const)(
    "keeps unsupported stage labels hidden under %s themes",
    (appearance) => {
      expect(resolveVisibleStageArtworkVariant("Preview", appearance)).toBeNull();
    },
  );
});
