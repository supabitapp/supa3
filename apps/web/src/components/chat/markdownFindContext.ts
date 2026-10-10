import { createContext, useCallback } from "react";

export const MarkdownFindContext = createContext(false);

export function useFindRevealRef(onReveal: () => void) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      element.addEventListener("beforematch", onReveal);
      return () => element.removeEventListener("beforematch", onReveal);
    },
    [onReveal],
  );
}
