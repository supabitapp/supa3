// @effect-diagnostics nodeBuiltinImport:off -- The packaging probe copies the installed dependency into an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { DESKTOP_RUNTIME_FILE_EXCLUSIONS } from "../../../../scripts/lib/desktop-external-packages.ts";

import {
  extractPlaywrightInjectedRuntimeSource,
  playwrightInjectedRuntimeInstallExpression,
  playwrightInjectedRuntimeSource,
} from "./PlaywrightInjectedRuntime.ts";

const bundleWithSourceLiteral = (literal: string): string =>
  `const source3 = ${literal};\n  }\n});`;

describe("playwright injected runtime", () => {
  effectIt.effect("extracts the runtime with only the packaged Playwright files available", () =>
    Effect.gen(function* () {
      const scratch = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "supacode-playwright-package-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const require = NodeModule.createRequire(import.meta.url);
      const source = NodePath.dirname(require.resolve("playwright-core/package.json"));
      const target = NodePath.join(scratch, "node_modules/playwright-core");
      yield* Effect.promise(() =>
        NodeFSP.cp(source, target, {
          recursive: true,
          filter: (entry) =>
            entry === source ||
            !DESKTOP_RUNTIME_FILE_EXCLUSIONS.some((pattern) =>
              NodePath.matchesGlob(
                `node_modules/playwright-core/${NodePath.relative(source, entry).replaceAll("\\", "/")}`,
                pattern.slice(1),
              ),
            ),
        }),
      );
      const packagedRequire = NodeModule.createRequire(NodePath.join(scratch, "probe.cjs"));
      const packageJsonPath = packagedRequire.resolve("playwright-core/package.json");
      const bundlePath = NodePath.join(NodePath.dirname(packageJsonPath), "lib/coreBundle.js");
      const coreBundle = yield* Effect.promise(() => NodeFSP.readFile(bundlePath, "utf8"));
      const runtime = yield* extractPlaywrightInjectedRuntimeSource(coreBundle, bundlePath);
      expect(runtime).toContain("InjectedScript");
      expect(yield* Effect.promise(() => NodeFSP.readdir(target))).toContain(
        "ThirdPartyNotices.txt",
      );
      expect(yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(target, "lib")))).toEqual([
        "coreBundle.js",
      ]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("extracts the pinned runtime from playwright-core", () =>
    Effect.gen(function* () {
      const source = yield* playwrightInjectedRuntimeSource();
      expect(source.length).toBeGreaterThan(100_000);
      expect(source).toContain("InjectedScript");
    }),
  );

  effectIt.effect("builds an idempotent install expression", () =>
    Effect.gen(function* () {
      const expression = yield* playwrightInjectedRuntimeInstallExpression();
      expect(expression).toContain("__supacodePlaywrightInjected");
      expect(expression).toContain('testIdAttributeName":"data-testid');
    }),
  );

  effectIt.effect("reports a missing source marker without an artificial cause", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        extractPlaywrightInjectedRuntimeSource("const source = 'missing';", "/tmp/coreBundle.js"),
      );

      expect(error).toMatchObject({
        _tag: "PlaywrightSourceMarkerNotFoundError",
        bundlePath: "/tmp/coreBundle.js",
        marker: "source3 = ",
      });
      expect("cause" in error).toBe(false);
    }),
  );

  effectIt.effect("keeps source validation metadata cause-free", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        extractPlaywrightInjectedRuntimeSource(
          bundleWithSourceLiteral('"short"'),
          "/tmp/coreBundle.js",
        ),
      );

      expect(error).toMatchObject({
        _tag: "PlaywrightSourceValidationError",
        bundlePath: "/tmp/coreBundle.js",
        actualType: "string",
        actualLength: 5,
        minimumLength: 100_000,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  effectIt.effect("preserves the source evaluation cause", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        extractPlaywrightInjectedRuntimeSource(bundleWithSourceLiteral("("), "/tmp/coreBundle.js"),
      );

      expect(error).toMatchObject({
        _tag: "PlaywrightSourceEvaluationError",
        bundlePath: "/tmp/coreBundle.js",
        timeoutMs: 1_000,
        cause: expect.objectContaining({ name: "SyntaxError" }),
      });
    }),
  );
});
