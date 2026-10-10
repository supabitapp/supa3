import type { ServerConfig } from "@supacode/contracts";

const TRIAGE_PLAYBOOK_URL =
  "https://raw.githubusercontent.com/supabitapp/supacode-next/main/.github/triage/PLAYBOOK.md";

export function buildFeedbackPrompt(input: {
  readonly serverConfig: Pick<ServerConfig, "environment" | "observability">;
  readonly client: string;
}): string {
  const { serverVersion } = input.serverConfig.environment;
  const { logsDirectoryPath } = input.serverConfig.observability;
  return `I want to send feedback about Supacode from the ${input.client}.

Run \`supacode triage --print\` and follow what it prints. If \`supacode\` is not on PATH or reports a version other than ${serverVersion}, run \`npx supacode@${serverVersion} triage --print\` instead. Never run it without \`--print\`, which starts another agent. This server logs to \`${logsDirectoryPath}\`; if the printed paths point elsewhere, add \`--base-dir\` with the Supacode data folder those logs are under. If neither command works or that version has no \`--print\`, follow ${TRIAGE_PLAYBOOK_URL} instead.`;
}
