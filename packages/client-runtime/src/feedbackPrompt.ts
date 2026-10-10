export function buildFeedbackPrompt(input: {
  readonly serverVersion: string;
  readonly client: string;
}): string {
  const { serverVersion } = input;
  return `I want to send feedback about Supacode from the ${input.client}.

Run \`supacode triage --print\` and follow what it prints. If \`supacode\` is not on PATH or reports a version other than ${serverVersion}, run \`npx supacode@${serverVersion} triage --print\` instead.`;
}
