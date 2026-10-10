const TRIAGE_PLAYBOOK_URL =
  "https://raw.githubusercontent.com/supabitapp/supacode-next/main/.github/triage/PLAYBOOK.md";

export function buildFeedbackPrompt(input: {
  readonly serverVersion: string;
  readonly client: string;
}): string {
  return `I want to send feedback about Supacode from the ${input.client}.

Run \`supacode triage --print\` and follow what it prints. If \`supacode\` is not on PATH or reports a version other than ${input.serverVersion}, run \`npx supacode@${input.serverVersion} triage --print\` instead. If that version has no \`--print\`, follow ${TRIAGE_PLAYBOOK_URL} instead.`;
}
