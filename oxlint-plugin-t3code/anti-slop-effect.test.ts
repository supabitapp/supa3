import { createOxlintRuleHarness } from "./test/utils.ts";

const tagComparison = createOxlintRuleHarness("anti-slop-effect/no-manual-tag-comparison", {
  pluginName: "anti-slop-effect",
  pluginPath: "oxlint-plugin-t3code/anti-slop-effect.ts",
});

tagComparison.valid(
  "predicate helper",
  'const isExpected = (value: unknown) => Predicate.isTagged(value, "Expected");',
);
tagComparison.invalid(
  "tag switch",
  'const read = (value: { _tag: string }) => { switch (value._tag) { case "Expected": return true; default: return false; } };',
);

const taggedConstruction = createOxlintRuleHarness(
  "anti-slop-effect/no-manual-tagged-construction",
  {
    pluginName: "anti-slop-effect",
    pluginPath: "oxlint-plugin-t3code/anti-slop-effect.ts",
  },
);

taggedConstruction.valid("match pattern", 'Match.when({ _tag: "Expected" }, () => true);');
taggedConstruction.invalid(
  "tag literal",
  'const failure = { _tag: "Expected", message: "failed" };',
);

const serviceImports = createOxlintRuleHarness("anti-slop-effect/no-service-constructor-imports", {
  filename: "src/runtime.ts",
  pluginName: "anti-slop-effect",
  pluginPath: "oxlint-plugin-t3code/anti-slop-effect.ts",
});

serviceImports.valid("layer import", 'import { Layer } from "effect"; void Layer;');
serviceImports.invalid(
  "constructor import",
  'import { makeWorkspace } from "./workspace.ts"; void makeWorkspace;',
);
