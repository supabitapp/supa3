import { EnvironmentId } from "@supacode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/env", () => ({ isElectron: true }));

import { rendersServerTabNatively } from "./previewRuntime";

const primary = EnvironmentId.make("primary-environment");

describe("rendersServerTabNatively", () => {
  it("streams a headless-backed server tab even in the primary desktop environment", () => {
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        browserBacking: "headless",
      }),
    ).toBe(false);
  });

  it("keeps native rendering for an attached primary-environment server tab", () => {
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        browserBacking: "desktop",
      }),
    ).toBe(true);
  });

  it("preserves legacy native behavior when the backing is absent", () => {
    expect(rendersServerTabNatively(primary, primary, { runtime: "server" })).toBe(true);
  });
});
