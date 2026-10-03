import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultWorktreeBaseBranch } from "./worktree-base-branch";

describe("resolveDefaultWorktreeBaseBranch", () => {
  it("prefers the repository default to the current feature branch", () => {
    expect(
      resolveDefaultWorktreeBaseBranch([
        { name: "feature/x", current: true, isDefault: false, isRemote: false },
        { name: "main", current: false, isDefault: true, isRemote: false },
      ]),
    ).toBe("main");
  });

  it("supports a default branch that exists only on a remote", () => {
    expect(
      resolveDefaultWorktreeBaseBranch([
        { name: "origin/main", current: false, isDefault: true, isRemote: true },
      ]),
    ).toBe("origin/main");
  });

  it("uses the current local branch when no default is available", () => {
    expect(
      resolveDefaultWorktreeBaseBranch([
        { name: "feature/x", current: true, isDefault: false, isRemote: false },
      ]),
    ).toBe("feature/x");
  });

  it("does not invent a base from an arbitrary branch or an empty cache", () => {
    expect(resolveDefaultWorktreeBaseBranch([])).toBeNull();
    expect(
      resolveDefaultWorktreeBaseBranch([
        { name: "release", current: false, isDefault: false, isRemote: false },
      ]),
    ).toBeNull();
  });
});
