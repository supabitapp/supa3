import { useCallback, useState } from "react";
import type { ThreadContentPresentation } from "./threadContentPresentation";

/** Keeps the loading handoff open until the incoming list has positioned its messages. */
export function useThreadFeedLoading(input: {
  readonly threadKey: string;
  readonly listMountKey: string;
  readonly contentKind: ThreadContentPresentation["kind"];
  readonly hasContent: boolean;
  readonly hasQueuedMessages: boolean;
}) {
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const [openingThreadKey, setOpeningThreadKey] = useState<string | null>(null);
  const fetchingMessages = input.contentKind === "loading" && !input.hasQueuedMessages;
  if (fetchingMessages && openingThreadKey !== input.threadKey) {
    setOpeningThreadKey(input.threadKey);
    setLoadedListKey(null);
  }
  const loading =
    fetchingMessages ||
    (openingThreadKey === input.threadKey &&
      input.contentKind === "ready" &&
      !input.hasQueuedMessages &&
      input.hasContent &&
      loadedListKey !== input.listMountKey);

  if (!loading && openingThreadKey !== null) setOpeningThreadKey(null);

  const onListLoaded = useCallback(() => {
    setLoadedListKey(input.listMountKey);
  }, [input.listMountKey]);

  return { loading, onListLoaded };
}
