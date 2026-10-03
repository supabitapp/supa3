import { createOxlintRuleHarness } from "./test/utils.ts";

const waits = createOxlintRuleHarness("test-waits/no-long-waits", {
  filename: "src/example.test.ts",
  pluginName: "test-waits",
  pluginPath: "oxlint-plugin-supacode/test-waits.ts",
});

waits.valid("short Effect sleep", "await Effect.sleep(1000);");
waits.valid("abort watchdog", "setTimeout(() => controller.abort(), 30000);");
waits.invalid("long Effect sleep", "await Effect.sleep(1001);");
waits.invalid("browser wait", "await page.waitForTimeout(10);");
waits.invalid("unknown timer", "await new Promise((resolve) => setTimeout(resolve, delay));");
