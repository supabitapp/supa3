import type { ServerProvider } from "@supacode/contracts";
import { headlineUsageWindows } from "@supacode/shared/usageLimits";
import { memo } from "react";

import { ProviderUsageWindowMeter } from "./ProviderUsageWindowMeter";

export const ComposerUsageMeter = memo(function ComposerUsageMeter({
  provider,
}: {
  readonly provider: ServerProvider | null;
}) {
  const windows = headlineUsageWindows(provider);
  if (windows.length === 0) return null;
  return (
    <div className="hidden items-center gap-4 px-4 pt-2 text-xs tabular-nums transition-[opacity,visibility] duration-150 ease-out peer-has-data-[chat-composer-resting]/composer-shell:invisible peer-has-data-[chat-composer-resting]/composer-shell:opacity-0 motion-reduce:transition-none sm:flex">
      {windows.map(({ label, window }) => (
        <ProviderUsageWindowMeter key={window.id} label={label} window={window} />
      ))}
    </div>
  );
});
