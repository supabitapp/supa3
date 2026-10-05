import type { ScopedThreadRef } from "@supacode/contracts";
import { useCallback } from "react";

import { useOpenLink } from "~/browser/useOpenLink";

import { toastManager } from "../ui/toast";

/** Opens the host page using the browser preference, without routing into the PR review panel. */
export function useOpenPullRequestHostLink(threadRef: ScopedThreadRef | null | undefined) {
  const openLink = useOpenLink(threadRef);
  return useCallback(
    async (...args: Parameters<typeof openLink>) => {
      try {
        await openLink(...args);
      } catch (error) {
        console.error(error);
        toastManager.add({ type: "error", title: "Could not open the link" });
      }
    },
    [openLink],
  );
}
