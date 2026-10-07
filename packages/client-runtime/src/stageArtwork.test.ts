import { describe, expect, it } from "vite-plus/test";

import {
  NIGHT_SKY_GRADIENT,
  reflectedGradient,
  resolveEnvironmentIdentificationModes,
  resolveEnvironmentIdentificationPillLabel,
  resolveStageArtworkVariant,
  resolveVisibleStageArtworkVariant,
  STAGE_ARTWORK_HEIGHT,
  WIREFRAME_PAPER_GRADIENT,
} from "./stageArtwork.ts";

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

  it("offers only the identification modes that change something", () => {
    expect(resolveEnvironmentIdentificationModes("Dev")).toEqual(["artwork", "pill", "none"]);
    expect(resolveEnvironmentIdentificationModes(null)).toEqual(["artwork", "none"]);
    expect(resolveEnvironmentIdentificationModes("Preview")).toEqual(["none"]);
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel(null)).toBeNull();
  });

  it.each([
    ["night sky", NIGHT_SKY_GRADIENT, 320],
    ["night sky", NIGHT_SKY_GRADIENT, 2400],
    ["wireframe", WIREFRAME_PAPER_GRADIENT, 320],
    ["wireframe", WIREFRAME_PAPER_GRADIENT, 2400],
  ] as const)("stretches the reflected %s gradient across a %i-unit canvas", (_, vector, width) => {
    const gradient = reflectedGradient(vector, width);
    const dx = gradient.x2 - gradient.x1;
    const dy = gradient.y2 - gradient.y1;
    const offsetAt = (x: number, y: number) =>
      ((x - gradient.x1) * dx + (y - gradient.y1) * dy) / (dx * dx + dy * dy);

    for (const [x, y] of [
      [0, 0],
      [width, 0],
      [0, STAGE_ARTWORK_HEIGHT],
      [width, STAGE_ARTWORK_HEIGHT],
    ] as const) {
      expect(offsetAt(x, y)).toBeGreaterThanOrEqual(0);
      expect(offsetAt(x, y)).toBeLessThanOrEqual(1);
    }
  });

  it("mirrors the gradient ahead of its start point", () => {
    const { stops } = reflectedGradient(WIREFRAME_PAPER_GRADIENT, 320);
    expect(stops[0]).toEqual({ offset: 0, color: "to" });
    expect(stops[2]?.color).toBe("from");
  });
});
