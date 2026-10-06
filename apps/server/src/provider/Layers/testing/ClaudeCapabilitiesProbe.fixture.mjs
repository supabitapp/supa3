#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
const args = process.argv.slice(2);
const mcpConfigIndex = args.indexOf("--mcp-config");
const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;
let mcpConfig;
if (rawMcpConfig) {
  const contents = NodeFS.existsSync(rawMcpConfig)
    ? NodeFS.readFileSync(rawMcpConfig, "utf8")
    : rawMcpConfig;
  try {
    mcpConfig = JSON.parse(contents);
  } catch {
    mcpConfig = contents;
  }
}
NodeFS.writeFileSync(
  process.env.SUPACODE_PROBE_INVOCATION_PATH,
  JSON.stringify({
    args,
    cwd: process.cwd(),
    connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,
    mcpConfig,
  }),
);
const settingsIndex = args.indexOf("--settings");
const flagSettings = settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : {};
let initializeCount = 0;
// Like Claude, only an SDK host that opts in gets the account check, and the
// account's status lands after the first initialize response.
function fastModeDisabledReason() {
  if (flagSettings.fastMode !== true) return "sdk_opt_in_required";
  return initializeCount++ > 0 ? "extra_usage_disabled" : undefined;
}
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") return;
  const reply = (response) =>
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response },
      }) + "\n",
    );
  if (message.request?.subtype === "initialize") {
    const reason = fastModeDisabledReason();
    reply({
      commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [],
      account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
      ...(reason ? { fast_mode_disabled_reason: reason } : {}),
    });
  }
  // The probe follows initialize with get_usage, then initializes again, on
  // the same process.
  if (message.request?.subtype === "get_usage") {
    reply({
      session: {},
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
      behaviors: null,
    });
  }
});
// Stay alive for follow-up control requests, but never outlive the
// parent: the probe aborts the SDK without awaiting the child, so an
// unconditional interval would strand this process until reboot.
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
