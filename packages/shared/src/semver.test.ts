import { describe, expect, it } from "vite-plus/test";

import {
  compareSemverVersions,
  normalizeSemverVersion,
  parseSemver,
  satisfiesSemverRange,
} from "./semver.ts";

describe("semver helpers", () => {
  it("orders calendar migration, feature counters, and annual rollover", () => {
    const versions = [
      "0.0.46",
      "26.0.0-nightly.20261004.123",
      "26.0.0",
      "26.0.1",
      "26.9.9",
      "26.10.0",
      "27.0.0",
    ];
    for (let index = 1; index < versions.length; index++) {
      expect(compareSemverVersions(versions[index - 1]!, versions[index]!)).toBeLessThan(0);
    }
  });
  it("matches supported range groups", () => {
    const range = "^22.16 || ^23.11 || >=24.10";

    expect(satisfiesSemverRange("22.16.0", range)).toBe(true);
    expect(satisfiesSemverRange("23.11.1", range)).toBe(true);
    expect(satisfiesSemverRange("24.10.0", range)).toBe(true);
    expect(satisfiesSemverRange("22.15.9", range)).toBe(false);
    expect(satisfiesSemverRange("23.10.9", range)).toBe(false);
    expect(satisfiesSemverRange("24.9.9", range)).toBe(false);
  });

  it("normalizes versions with a missing patch segment", () => {
    expect(normalizeSemverVersion("2.1")).toBe("2.1.0");
  });

  it("normalizes and parses shorthand major-only versions", () => {
    expect(normalizeSemverVersion("20")).toBe("20.0.0");
    expect(normalizeSemverVersion("v18")).toBe("v18.0.0");
    expect(normalizeSemverVersion("20-rc.1")).toBe("20.0.0-rc.1");
    expect(parseSemver("20")).toEqual({ major: 20, minor: 0, patch: 0, prerelease: [] });
  });

  it("compares shorthand versions numerically instead of lexically", () => {
    // Regression: "20" vs "9" previously fell back to string comparison, which
    // ordered "20" before "9" ("2" < "9").
    expect(compareSemverVersions("20", "9")).toBeGreaterThan(0);
    expect(compareSemverVersions("18", "18.0.0")).toBe(0);
  });

  it("still rejects non-numeric shorthand and keeps empty input empty", () => {
    expect(parseSemver("abc")).toBeNull();
    expect(normalizeSemverVersion("")).toBe("");
  });

  it("compares prerelease versions before stable versions", () => {
    expect(compareSemverVersions("2.1.111-beta.1", "2.1.111")).toBeLessThan(0);
  });

  it("falls back to lexical comparison for malformed numeric segments", () => {
    expect(compareSemverVersions("1.2.3abc", "1.2.10")).toBeGreaterThan(0);
  });

  it("supports comparison comparators", () => {
    expect(satisfiesSemverRange("24.9.0", ">=24.0 <24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">=24.0 <24.10")).toBe(false);
  });

  it("honors caret range upper bounds for zero-major versions", () => {
    expect(satisfiesSemverRange("0.2.3", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.5.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesSemverRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("rejects invalid versions and unsupported range syntax", () => {
    expect(satisfiesSemverRange("not-a-version", ">=24.0")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", "~24.10")).toBe(false);
  });

  it("keeps the range checker stringifiable and executable as plain JavaScript", () => {
    const source = satisfiesSemverRange.toString();
    const recreated = Function(`return (${source});`)() as typeof satisfiesSemverRange;

    expect(source).toContain("function satisfiesSemverRange");
    expect(source).not.toContain(": string");
    expect(source).not.toContain(": boolean");
    expect(recreated("24.10.0", ">=24.10")).toBe(true);
    expect(recreated("24.9.9", ">=24.10")).toBe(false);
  });
});
