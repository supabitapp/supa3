import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationModes,
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  const november = new Date(2026, 10, 30, 23, 59);
  const december = new Date(2026, 11, 1);

  it("resolves stage artwork for Dev and Nightly", () => {
    expect(resolveSidebarStageBackdropVariant("Dev", november)).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly", november)).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant(null, november)).toBeNull();
  });

  it("gives release builds sleigh artwork through December only", () => {
    expect(resolveSidebarStageBackdropVariant(null, december)).toBe("release");
    expect(resolveSidebarStageBackdropVariant("Latest", december)).toBe("release");
    expect(resolveSidebarStageBackdropVariant("Nightly", december)).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Latest", new Date(2027, 0, 1))).toBeNull();
  });

  it("offers only the identification modes that change something", () => {
    expect(resolveEnvironmentIdentificationModes("Dev", november)).toEqual([
      "artwork",
      "pill",
      "none",
    ]);
    expect(resolveEnvironmentIdentificationModes(null, december)).toEqual(["artwork", "none"]);
    expect(resolveEnvironmentIdentificationModes("Latest", november)).toEqual(["none"]);
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel(null)).toBeNull();
  });

  it.each(["nightly", "dev", "release"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
