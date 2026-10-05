import type {
  OrchestrationThreadMessageSearchMatch,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@supacode/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { onOpenThreadFind } from "../../threadFindBus";
import { toastManager } from "../ui/toast";
import type { ThreadFindRequest } from "./useThreadFindTarget";

/** Owns current-thread find activation and race-safe bounded history navigation. */
export function useThreadFind({
  threadKey,
  threadRef,
  isServerThread,
  onManualNavigation,
  onOpen,
  onClose,
}: {
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly isServerThread: boolean;
  readonly onManualNavigation: () => void;
  readonly onOpen?: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const loadAroundThreadHistory = useAtomCommand(threadEnvironment.loadAroundHistory, {
    label: "load thread search result",
    reportFailure: false,
  });
  const [threadFind, setThreadFind] = useState<{ threadKey: string; focusRequest: number } | null>(
    null,
  );
  const [threadFindTarget, setThreadFindTarget] = useState<
    (ThreadFindRequest & { threadKey: string; projection: OrchestrationV2ThreadProjection }) | null
  >(null);
  const threadFindGenerationRef = useRef(0);
  const threadFindOpen = isServerThread && threadFind?.threadKey === threadKey;
  const openActiveThreadFind = useCallback(() => {
    if (!isServerThread || threadKey === null) return;
    onOpen?.();
    setThreadFind((current) => ({
      threadKey,
      focusRequest: (current?.focusRequest ?? 0) + 1,
    }));
  }, [threadKey, isServerThread, onOpen]);
  const closeActiveThreadFind = useCallback(() => {
    threadFindGenerationRef.current += 1;
    setThreadFind(null);
    setThreadFindTarget(null);
    onClose();
  }, [onClose]);
  if (threadFind !== null && threadFind.threadKey !== threadKey) {
    setThreadFind(null);
    setThreadFindTarget(null);
  }
  useEffect(() => {
    if (threadKey === null) return;
    return () => {
      threadFindGenerationRef.current += 1;
    };
  }, [threadKey]);
  useEffect(
    () =>
      onOpenThreadFind((target) => {
        if (
          target.environmentId === threadRef?.environmentId &&
          target.threadId === threadRef.threadId
        )
          openActiveThreadFind();
      }),
    [threadRef, openActiveThreadFind],
  );
  const navigateThreadFind = useCallback(
    (match: OrchestrationThreadMessageSearchMatch | null, query: string) => {
      const generation = ++threadFindGenerationRef.current;
      if (!match || !threadRef || threadKey === null) {
        setThreadFindTarget(null);
        return;
      }
      onManualNavigation();
      const request = {
        threadKey,
        key: JSON.stringify([threadKey, query, match.index, generation]),
        match,
      };
      void loadAroundThreadHistory({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          target: { itemId: match.itemId, threadId: match.threadId },
        },
      }).then((result) => {
        if (generation !== threadFindGenerationRef.current) return;
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not load search result",
            description: error instanceof Error ? error.message : "Try searching again.",
          });
          return;
        }
        if (result.value._tag === "error") {
          toastManager.add({
            type: "error",
            title: "Could not load search result",
            description: result.value.message,
          });
          return;
        }
        if (result.value._tag === "loaded") {
          setThreadFindTarget({ ...request, projection: result.value.projection });
        } else {
          toastManager.add({
            type: "warning",
            title: "The conversation changed while loading this match",
            description: "Refresh the search to show it again.",
          });
        }
      });
    },
    [threadKey, threadRef, onManualNavigation, loadAroundThreadHistory],
  );

  return {
    isOpen: threadFindOpen,
    focusRequest: threadFind?.focusRequest ?? 0,
    request: threadFindOpen && threadFindTarget?.threadKey === threadKey ? threadFindTarget : null,
    open: openActiveThreadFind,
    close: closeActiveThreadFind,
    navigate: navigateThreadFind,
  };
}
