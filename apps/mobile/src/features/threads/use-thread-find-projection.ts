import type {
  OrchestrationThreadMessageSearchMatch,
  OrchestrationV2ThreadProjection,
} from "@supacode/contracts";
import type { ThreadHistoryLoadAroundResult } from "@supacode/client-runtime/state/threads";
import { threadSearchWindowContainsMatch } from "@supacode/client-runtime/state/thread-search";
import { useCallback, useRef } from "react";

/** Keep nearby find hits on the same bounded snapshot until the results are refreshed. */
export function useThreadFindProjection(
  load: (match: OrchestrationThreadMessageSearchMatch) => Promise<ThreadHistoryLoadAroundResult>,
) {
  const projection = useRef<OrchestrationV2ThreadProjection | null>(null);
  const generation = useRef(0);
  const invalidateProjection = useCallback(() => {
    projection.current = null;
    generation.current += 1;
  }, []);
  const loadProjection = useCallback(
    async (match: OrchestrationThreadMessageSearchMatch) => {
      const cached = projection.current;
      if (cached !== null && threadSearchWindowContainsMatch(cached.visibleTurnItems, match)) {
        return { _tag: "loaded", projection: cached } as const;
      }
      const requestedGeneration = generation.current;
      const result = await load(match);
      if (result._tag === "loaded" && generation.current === requestedGeneration) {
        projection.current = result.projection;
      }
      return result;
    },
    [load],
  );
  return { loadProjection, invalidateProjection };
}
