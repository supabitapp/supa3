import { createOxlintRuleHarness } from "./test/utils.ts";

const tagComparison = createOxlintRuleHarness("anti-slop-effect/no-manual-tag-comparison", {
  pluginName: "anti-slop-effect",
  pluginPath: "oxlint-plugin-supacode/anti-slop-effect.ts",
});

tagComparison.valid(
  "predicate helper",
  'const isExpected = (value: unknown) => Predicate.isTagged(value, "Expected");',
);
tagComparison.invalid(
  "tag switch",
  'const read = (value: { _tag: string }) => { switch (value._tag) { case "Expected": return true; default: return false; } };',
);

const errorTag = createOxlintRuleHarness("anti-slop-effect/no-manual-effect-error-tag", {
  pluginName: "anti-slop-effect",
  pluginPath: "oxlint-plugin-supacode/anti-slop-effect.ts",
});

errorTag.valid(
  "predicate outside catch",
  'const read = (value: { _tag: string }) => value._tag === "Expected";',
);
errorTag.invalid(
  "broad catch comparison",
  'Effect.catchAll(effect, (error) => error._tag === "Expected");',
);

const taggedConstruction = createOxlintRuleHarness(
  "anti-slop-effect/no-manual-tagged-construction",
  {
    pluginName: "anti-slop-effect",
    pluginPath: "oxlint-plugin-supacode/anti-slop-effect.ts",
  },
);

taggedConstruction.valid("match pattern", 'Match.when({ _tag: "Expected" }, () => true);');
taggedConstruction.invalid(
  "tag literal",
  'const failure = { _tag: "Expected", message: "failed" };',
);

const effectMatch = createOxlintRuleHarness("anti-slop-effect/prefer-effect-match", {
  pluginName: "anti-slop-effect",
  pluginPath: "oxlint-plugin-supacode/anti-slop-effect.ts",
});

effectMatch.valid("single branch", 'const result = value === "Expected" ? first : fallback;');
effectMatch.invalid(
  "chained branches",
  'const result = value === "Expected" ? first : value === "Other" ? second : fallback;',
);

const serviceImports = createOxlintRuleHarness("anti-slop-effect/no-service-constructor-imports", {
  filename: "src/runtime.ts",
  pluginName: "anti-slop-effect",
  pluginPath: "oxlint-plugin-supacode/anti-slop-effect.ts",
});

serviceImports.valid("layer import", 'import { Layer } from "effect"; void Layer;');
serviceImports.invalid(
  "constructor import",
  'import { makeWorkspace } from "./workspace.ts"; void makeWorkspace;',
);
