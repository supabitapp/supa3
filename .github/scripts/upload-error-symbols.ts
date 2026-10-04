import { uploadSourceMaps } from "../../scripts/lib/posthog-source-maps.ts";
if (process.env.GITHUB_ACTIONS === "true" && process.env.POSTHOG_CLI_API_KEY) {
  console.log(`::add-mask::${process.env.POSTHOG_CLI_API_KEY}`);
}
for (const directory of (process.env.ERROR_SYMBOL_DIRECTORIES ?? "")
  .split(/\r?\n/)
  .filter(Boolean)) {
  await uploadSourceMaps(directory, process.env.ERROR_SYMBOL_NAMESPACE);
}
