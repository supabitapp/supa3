import { describe, expect, it } from "vite-plus/test";

import {
  resolveDefaultWorktreeBaseBranch,
  resolveProjectThreadCreationBranch,
} from "./projectThreadCreationValidation";

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

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched local draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("prefers an explicit picker choice over the current checkout", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });

  it("stays null when no ref is checked out (detached HEAD, non-repository, status not loaded)", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: null,
      }),
    ).toBeNull();
  });

  it("never borrows the current checkout for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBeNull();
  });

  it("keeps the explicit base branch for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });
});
