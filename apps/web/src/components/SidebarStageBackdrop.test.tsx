import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationModes,
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveVisibleSidebarStageBackdropVariant,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork per channel", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Latest")).toBe("release");
    expect(resolveSidebarStageBackdropVariant(null)).toBe("release");
    expect(resolveSidebarStageBackdropVariant("Preview")).toBeNull();
  });

  it.each(["light", "dark"] as const)("keeps channel artwork under %s themes", (appearance) => {
    expect(resolveVisibleSidebarStageBackdropVariant("Nightly", appearance)).toBe("nightly");
    expect(resolveVisibleSidebarStageBackdropVariant("Dev", appearance)).toBe("dev");
  });

  it("shows the release artwork only under dark themes", () => {
    expect(resolveVisibleSidebarStageBackdropVariant(null, "dark")).toBe("release");
    expect(resolveVisibleSidebarStageBackdropVariant("Latest", "dark")).toBe("release");
    expect(resolveVisibleSidebarStageBackdropVariant(null, "light")).toBeNull();
    expect(resolveVisibleSidebarStageBackdropVariant("Latest", "light")).toBeNull();
  });

  it.each(["light", "dark"] as const)(
    "keeps unsupported stage labels hidden under %s themes",
    (appearance) => {
      expect(resolveVisibleSidebarStageBackdropVariant("Preview", appearance)).toBeNull();
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
