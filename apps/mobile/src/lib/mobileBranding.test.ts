import { describe, expect, it } from "vite-plus/test";

import { resolveMobileStageLabel } from "./mobileBranding";

describe("resolveMobileStageLabel", () => {
  it("does not label production builds or missing build metadata", () => {
    expect(resolveMobileStageLabel("production")).toBeNull();
    expect(resolveMobileStageLabel(undefined)).toBeNull();
  });

  it("keeps development and preview builds labeled", () => {
    expect(resolveMobileStageLabel("development")).toBe("Dev");
    expect(resolveMobileStageLabel("preview")).toBe("Nightly");
  });
});
