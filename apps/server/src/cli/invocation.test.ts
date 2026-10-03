import { assert, it } from "@effect/vitest";

import { formatCliCommand } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/supacode/dist/bin.mjs", "npx supacode serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\supacode\\dist\\bin.mjs",
      "npx supacode serve",
    ],
    ["/home/theo/.cache/pnpm/dlx/abc/node_modules/supacode/dist/bin.mjs", "pnpm dlx supacode serve"],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/supacode/dist/bin.mjs",
      "pnpm dlx supacode serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\supacode\\dist\\bin.mjs",
      "pnpm dlx supacode serve",
    ],
    ["/home/theo/.bun/install/cache/supacode@0.0.31/dist/bin.mjs", "bunx supacode serve"],
    ["/tmp/bunx-1000-supacode@latest/node_modules/supacode/dist/bin.mjs", "bunx supacode serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-supacode@latest\\node_modules\\supacode\\dist\\bin.mjs",
      "bunx supacode serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/supacode/dist/bin.mjs",
    "/home/theo/Code/work/supacode/apps/server/dist/bin.mjs",
    "/home/theo/.supacode/runtime/0.0.31/node_modules/supacode/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "supacode serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx supacode@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx supacode@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx supacode serve"],
    ["0.0.31", "npx supacode serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/supacode/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/supacode/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx supacode@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-supacode@latest/node_modules/supacode/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx supacode serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/supacode/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "supacode serve",
  );
});
