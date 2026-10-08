import { PencilIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { Textarea } from "../../../components/ui/textarea";
import { useProjects } from "../../../state/entities";
import { IN_FLIGHT, NEEDS_YOU, uniqueOpenPrs, type ProtoData } from "../data";
import { useWidgetEnv, useWidgetFrame } from "../widgets/context";
import type { TileRequest } from "./protocol";
import { TileRenderer } from "./Renderer";
import { drawTile, useTile } from "./store";

const EXAMPLES = [
  "Pull requests with failing checks",
  "What finished while I was away",
  "Threads started per day this month",
  "Who is working right now, by project",
];

const dateFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

function summarize(data: ProtoData) {
  const prs = uniqueOpenPrs(data.threads);
  return [
    `${data.threads.filter((t) => NEEDS_YOU.has(t.status)).length} threads need the user`,
    `${data.threads.filter((t) => IN_FLIGHT.has(t.status)).length} working`,
    `${data.threads.filter((t) => t.status === "ready" && t.unread).length} finished and unread`,
    `${data.threads.filter((t) => t.planReady).length} plans waiting`,
    `${prs.length} open pull requests, ${prs.filter((pr) => pr.checks === "failing").length} with failing checks`,
  ].join(", ");
}

function PromptForm(props: {
  initial: string;
  error: string | null;
  onSubmit: (prompt: string) => void;
  onCancel?: () => void;
}) {
  const { preview, bodyHeight } = useWidgetFrame();
  const [text, setText] = useState(props.initial);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (text.trim()) props.onSubmit(text.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && props.onCancel) {
      event.preventDefault();
      props.onCancel();
    }
  };
  return (
    <form onSubmit={submit} className="flex h-full flex-col gap-2 px-3 pb-3">
      <Textarea
        size="sm"
        aria-label="Describe the tile"
        placeholder="Describe a tile, like “open PRs with failing checks”"
        value={text}
        disabled={preview}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {props.error ? (
        <p role="alert" className="line-clamp-2 text-xs text-error">
          {props.error}
        </p>
      ) : null}
      {bodyHeight > 200 && !props.error ? (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              tabIndex={preview ? -1 : undefined}
              onClick={() => setText(example)}
              className="rounded-md bg-muted px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-end gap-1.5">
        {props.onCancel ? (
          <Button size="xs" variant="ghost" type="button" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="xs" type="submit" disabled={preview || !text.trim()}>
          Draw tile
        </Button>
      </div>
    </form>
  );
}

function Drawing({ prompt }: { prompt: string }) {
  return (
    <div role="status" className="flex h-full flex-col justify-center gap-1.5 px-4 pb-3">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <Spinner size="sm" />
        Drawing your tile
      </p>
      <p className="line-clamp-2 text-xs text-muted-foreground">“{prompt}”</p>
      <p className="text-xs text-secondary-label">This usually takes 10 to 30 seconds.</p>
    </div>
  );
}

function tileMode(hasSpec: boolean, drawing: boolean, editing: boolean) {
  if (!hasSpec) return drawing ? "drawing" : "empty";
  return editing ? "editing" : "showing";
}

export function AgentTileBody() {
  const { id, size, bodyHeight, preview } = useWidgetFrame();
  const { data } = useWidgetEnv();
  const projects = useProjects();
  const tile = useTile(id);
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const draw = (prompt: string, revise: boolean) => {
    setEditing(false);
    const request: TileRequest = {
      prompt,
      size,
      width: boxRef.current?.offsetWidth ?? 480,
      height: bodyHeight,
      context: {
        today: dateFormat.format(Date.now()),
        project: data.project?.title ?? null,
        projects: projects.map((p) => p.title).slice(0, 100),
        models: [...new Set(data.threads.flatMap((t) => (t.model ? [t.model] : [])))].slice(0, 8),
        summary: summarize(data),
      },
      previous: revise ? tile.raw : null,
    };
    void drawTile(id, request);
  };

  const spec = preview ? null : tile.spec;
  const mode = tileMode(spec !== null, tile.drawing, editing);

  return (
    <div ref={boxRef} className="h-full">
      {mode === "empty" ? (
        <PromptForm initial={tile.prompt} error={tile.error} onSubmit={(p) => draw(p, false)} />
      ) : null}
      {mode === "drawing" ? <Drawing prompt={tile.prompt} /> : null}
      {mode === "editing" ? (
        <PromptForm
          initial={tile.prompt}
          error={null}
          onSubmit={(p) => draw(p, true)}
          onCancel={() => setEditing(false)}
        />
      ) : null}
      {mode === "showing" && spec ? (
        <div className="group/tile relative h-full">
          <div className={tile.drawing ? "h-full opacity-40" : "h-full"}>
            <TileRenderer spec={spec} />
          </div>
          <div className="absolute inset-x-2 bottom-2 flex items-center justify-end gap-2">
            {tile.drawing ? (
              <p role="status" className="flex flex-1 items-center justify-center gap-2 text-xs">
                <Spinner size="xs" />
                Redrawing
              </p>
            ) : null}
            {tile.error && !tile.drawing ? (
              <p
                role="alert"
                className="min-w-0 flex-1 truncate rounded-md bg-card px-1 text-xs text-error"
              >
                {tile.error}
              </p>
            ) : null}
            {tile.drawing ? null : (
              <div
                className={
                  tile.error
                    ? "flex gap-0.5 rounded-md bg-card shadow-(--proto-card-shadow)"
                    : "flex gap-0.5 rounded-md bg-card opacity-0 shadow-(--proto-card-shadow) transition-opacity duration-150 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 pointer-coarse:opacity-100"
                }
              >
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Change this tile"
                  onClick={() => setEditing(true)}
                >
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Draw this tile again"
                  onClick={() => draw(tile.prompt, false)}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
