import type {
  EnvironmentId,
  OrchestrationThreadMessageSearchMatch,
  ThreadId,
} from "@supacode/contracts";
import { ChevronDownIcon, ChevronUpIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const PAGE_SIZE = 50;

/** Search persisted message text; the excerpt also reveals matches hidden by Markdown. */
export function ThreadFindBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly focusRequest: number;
  readonly settledRunId: string | null;
  readonly onNavigate: (match: OrchestrationThreadMessageSearchMatch | null, query: string) => void;
  readonly onClose: () => void;
}) {
  const { focusRequest, onNavigate, settledRunId } = props;
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState({ query: "", index: 0 });
  const normalizedQuery = query.trim();
  const settledQuery = useDebouncedValue(normalizedQuery, 200);
  const readyQuery = normalizedQuery === settledQuery ? settledQuery : "";
  const index = selection.query === readyQuery ? selection.index : 0;
  const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
  const atom = useMemo(
    () =>
      readyQuery.length > 0
        ? orchestrationEnvironment.threadMessageSearch({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, query: readyQuery, offset, limit: PAGE_SIZE },
          })
        : null,
    [offset, props.environmentId, props.threadId, readyQuery],
  );
  const result = useEnvironmentQuery(atom);
  const previousSettledRun = useRef(settledRunId);
  const refresh = result.refresh;
  useEffect(() => {
    if (previousSettledRun.current === settledRunId) return;
    previousSettledRun.current = settledRunId;
    if (settledRunId !== null) refresh();
  }, [refresh, settledRunId]);
  const match = result.data?.matches.find((candidate) => candidate.index === index) ?? null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);
  useEffect(() => {
    onNavigate(match, readyQuery);
  }, [match, onNavigate, readyQuery]);
  const pending =
    normalizedQuery.length > 0 && (normalizedQuery !== settledQuery || result.isPending);
  const total = result.data?.totalMatches ?? 0;
  if (total > 0 && index >= total && !pending) {
    setSelection({ query: readyQuery, index: total - 1 });
  }
  const move = (direction: -1 | 1) => {
    if (total === 0 || pending) return;
    setSelection({ query: readyQuery, index: (index + direction + total) % total });
  };
  const start = match === null ? 0 : match.start - match.snippetStart;
  const end = match === null ? 0 : match.end - match.snippetStart;

  return (
    <div
      className="z-20 shrink-0 border-b border-border bg-background px-3 py-2 sm:px-5"
      data-thread-find
    >
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Input
            ref={inputRef}
            size="compact"
            type="search"
            aria-label="Find in thread"
            placeholder="Find in thread"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onClose();
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                move(event.shiftKey ? -1 : 1);
              }
            }}
          />
        </div>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          role="status"
          aria-live="polite"
        >
          {pending
            ? "Searching…"
            : normalizedQuery.length === 0
              ? ""
              : `${match ? index + 1 : 0} of ${total}`}
        </span>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Previous match"
          disabled={total === 0 || pending}
          onClick={() => move(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Next match"
          disabled={total === 0 || pending}
          onClick={() => move(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Refresh thread search"
          disabled={readyQuery.length === 0 || pending}
          onClick={result.refresh}
        >
          <RefreshCwIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Close thread search"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {result.error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {result.error}
        </p>
      ) : null}
      {match && !pending ? (
        <div className="mt-1.5">
          <p className="text-2xs text-muted-foreground">Showing messages around this match</p>
          <p
            className="wrap-anywhere font-mono text-xs text-muted-foreground"
            aria-label="Selected match excerpt"
          >
            {match.snippetStart > 0 ? "…" : ""}
            {match.snippet.slice(0, start)}
            <mark className="rounded-sm bg-primary/20 text-foreground">
              {match.snippet.slice(start, end)}
            </mark>
            {match.snippet.slice(end)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
