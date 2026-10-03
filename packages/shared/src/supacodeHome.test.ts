import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultSupacodeHome } from "./supacodeHome.ts";

const join = (first: string, ...rest: string[]) => [first, ...rest].join("/");
const existing = (paths: ReadonlyArray<string>) => (path: string) => paths.includes(path);

describe("resolveDefaultSupacodeHome", () => {
  it("uses ~/.supacode on a fresh machine", () => {
    expect(resolveDefaultSupacodeHome("/home/u", join, existing([]))).toBe("/home/u/.supacode");
  });

  it("keeps using ~/.supa3 when only the pre-rename home exists", () => {
    expect(resolveDefaultSupacodeHome("/home/u", join, existing(["/home/u/.supa3"]))).toBe(
      "/home/u/.supa3",
    );
  });

  it("prefers ~/.supacode once it exists", () => {
    expect(
      resolveDefaultSupacodeHome(
        "/home/u",
        join,
        existing(["/home/u/.supa3", "/home/u/.supacode"]),
      ),
    ).toBe("/home/u/.supacode");
  });
});
