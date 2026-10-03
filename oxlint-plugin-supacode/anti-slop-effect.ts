import { eslintCompatPlugin } from "@oxlint/plugins";

import { noManualEffectErrorTagRule } from "./anti-slop-effect/rules/no-manual-effect-error-tag.ts";
import { noManualTagComparisonRule } from "./anti-slop-effect/rules/no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./anti-slop-effect/rules/no-manual-tagged-construction.ts";
import { noServiceConstructorImportsRule } from "./anti-slop-effect/rules/no-service-constructor-imports.ts";
import { preferEffectMatchRule } from "./anti-slop-effect/rules/prefer-effect-match.ts";

export default eslintCompatPlugin({
  meta: { name: "anti-slop-effect" },
  rules: {
    "no-manual-effect-error-tag": noManualEffectErrorTagRule,
    "no-manual-tag-comparison": noManualTagComparisonRule,
    "no-manual-tagged-construction": noManualTaggedConstructionRule,
    "no-service-constructor-imports": noServiceConstructorImportsRule,
    "prefer-effect-match": preferEffectMatchRule,
  },
});
