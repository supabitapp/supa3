import type { UsageProviderKind, UsageSource } from "@supacode/contracts";
import type { UsageRecord } from "./usageTranscripts.ts";

export interface ScannedUsageSource {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly action?: UsageSource["action"];
  /** Parsed records per file, or `null` when the directory does not exist. */
  readonly files:
    | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
    | null;

  readonly refreshing?: true;
}
