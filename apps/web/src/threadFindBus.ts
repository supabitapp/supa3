import type { ScopedThreadRef } from "@supacode/contracts";

const THREAD_FIND_EVENT = "supacode:find-in-thread";

export function openThreadFind(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(THREAD_FIND_EVENT, { detail: threadRef }));
}

export function onOpenThreadFind(listener: (threadRef: ScopedThreadRef) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ScopedThreadRef>).detail);
  window.addEventListener(THREAD_FIND_EVENT, handler);
  return () => window.removeEventListener(THREAD_FIND_EVENT, handler);
}
