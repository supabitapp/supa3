// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("returns only the process env for a clone without env files", () => {
    expect(
      loadRepoEnv({
        baseEnv: { T3CODE_DEV_AUTH_TOKEN: "token_ci" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({ T3CODE_DEV_AUTH_TOKEN: "token_ci" });
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_DEV_AUTH_TOKEN=token_root\nT3CODE_ROOT_ONLY=root\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_DEV_AUTH_TOKEN=token_local\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toEqual({
      T3CODE_DEV_AUTH_TOKEN: "token_local",
      T3CODE_ROOT_ONLY: "root",
    });
    expect(loadRepoEnv({ baseEnv: { T3CODE_DEV_AUTH_TOKEN: "token_ci" }, repoRoot })).toEqual({
      T3CODE_DEV_AUTH_TOKEN: "token_ci",
      T3CODE_ROOT_ONLY: "root",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
