# Usage data and error reports

The Supacode server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `SUPACODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent.

Official releases also send anonymous error reports. Reports contain an error type, sanitized
stack frames, release version, and app surface. They exclude exception messages, prompts, responses,
file contents, URLs, and conversation identifiers. Supacode does not record sessions or replays.

Open Settings → General → Diagnostics to turn error reporting off or on for this device. On mobile,
use Settings → About Supacode → Diagnostics. Mobile sends reports directly and has its own device preference;
a server's opt-out does not control the phone. Web and desktop send reports through the connected
server, where `SUPACODE_TELEMETRY_ENABLED=false` also suppresses error reports. Set
`SUPACODE_ERROR_TRACKING_ENABLED=false` on a server to stop only error reports.
