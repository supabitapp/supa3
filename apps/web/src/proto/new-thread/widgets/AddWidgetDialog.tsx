import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "../../../components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../../components/ui/dialog";
import { cn } from "../../../lib/utils";
import { WidgetFrameContext, bodyHeightFor } from "./context";
import { WidgetBoundary, WidgetHeading } from "./card";
import { GRID_GAP, ROW_HEIGHT, SIZES, SIZE_ORDER, type WidgetSize } from "./layout";
import { CATEGORIES, WIDGETS, type WidgetDef } from "./registry";

export function AddWidgetDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placed: ReadonlyArray<string>;
  onAdd: (id: string, size: WidgetSize) => void;
}) {
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [pickedSize, setPickedSize] = useState<WidgetSize | null>(null);
  const firstFree = WIDGETS.find((w) => !w.multiple && !props.placed.includes(w.id)) ?? WIDGETS[0]!;
  const def = WIDGETS.find((w) => w.id === pickedId) ?? firstFree;
  const size = pickedSize && def.sizes.includes(pickedSize) ? pickedSize : def.sizes[0]!;
  const onScreen = props.placed.includes(def.id);

  const needle = query.trim().toLowerCase();
  const groups = CATEGORIES.map((category) => ({
    category,
    widgets: WIDGETS.filter(
      (w) =>
        w.category === category &&
        (!needle || `${w.title} ${w.description}`.toLowerCase().includes(needle)),
    ),
  })).filter((g) => g.widgets.length > 0);

  const pick = (id: string) => {
    setPickedId(id);
    setPickedSize(null);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          setQuery("");
          setPickedId(null);
          setPickedSize(null);
        }
        props.onOpenChange(open);
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="h-[min(600px,88vh)] max-w-[min(900px,calc(100vw-2rem))] overflow-hidden"
      >
        <div className="flex h-full min-h-0 max-[720px]:flex-col">
          <div className="flex w-[300px] shrink-0 flex-col border-r max-[720px]:h-1/2 max-[720px]:w-full max-[720px]:border-r-0 max-[720px]:border-b">
            <div className="flex flex-col gap-0.5 px-4 pt-3.5 pb-2.5">
              <DialogTitle>Add a widget</DialogTitle>
              <DialogDescription>Pick one to see it with your data.</DialogDescription>
            </div>
            <label className="mx-3 flex h-8 items-center gap-2 rounded-lg border bg-background px-2 text-sm focus-within:ring-2 focus-within:ring-ring">
              <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search widgets"
                aria-label="Search widgets"
                className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-placeholder sm:text-sm"
              />
            </label>
            <div
              role="list"
              aria-label="Widgets"
              className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
            >
              {groups.map((group) => (
                <div
                  key={group.category}
                  role="listitem"
                  aria-label={group.category}
                  className="pb-1.5"
                >
                  <p className="px-2 pt-1.5 pb-1 text-2xs text-muted-foreground">
                    {group.category}
                  </p>
                  {group.widgets.map((w) => (
                    <WidgetOption
                      key={w.id}
                      widget={w}
                      selected={w.id === def.id}
                      onScreen={props.placed.includes(w.id)}
                      onSelect={() => pick(w.id)}
                      onAdd={() => {
                        if (!props.placed.includes(w.id)) props.onAdd(w.id, w.sizes[0]!);
                      }}
                    />
                  ))}
                </div>
              ))}
              {groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No widget matches “{query}”.
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/40">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
              <Preview def={def} size={size} />
            </div>
            <div className="flex flex-col gap-3 border-t bg-popover px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-48 flex-1 flex-col">
                  <span className="text-sm font-medium text-foreground">{def.title}</span>
                  <span className="text-xs text-muted-foreground">{def.description}</span>
                </div>
                {def.sizes.length > 1 ? (
                  <div
                    role="radiogroup"
                    aria-label="Size"
                    className="flex items-center rounded-lg border p-0.5"
                  >
                    {SIZE_ORDER.filter((s) => def.sizes.includes(s)).map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={s === size}
                        onClick={() => setPickedSize(s)}
                        className={cn(
                          "h-6 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          s === size
                            ? "bg-foreground text-background"
                            : "text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {SIZES[s].label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <Button size="sm" disabled={onScreen} onClick={() => props.onAdd(def.id, size)}>
                  {onScreen ? <CheckIcon /> : <PlusIcon />}
                  {onScreen ? "On screen" : "Add"}
                </Button>
              </div>
              <dl className="grid grid-cols-[48px_1fr] gap-x-3 text-xs">
                <dt className="text-muted-foreground">Data</dt>
                <dd className="text-foreground">{def.source}</dd>
              </dl>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function WidgetOption(props: {
  widget: WidgetDef;
  selected: boolean;
  onScreen: boolean;
  onSelect: () => void;
  onAdd: () => void;
}) {
  const Icon = props.widget.icon;
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      onFocus={props.onSelect}
      onDoubleClick={props.onAdd}
      onKeyDown={(event) => {
        if (event.key === "Enter" && props.selected) {
          event.preventDefault();
          props.onAdd();
        }
      }}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        props.selected && "bg-accent",
      )}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
        <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-sm">
          <span className="truncate font-medium text-foreground">{props.widget.title}</span>
          {props.onScreen ? (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground">
              <CheckIcon aria-hidden className="size-3" /> On screen
            </span>
          ) : null}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {props.widget.description}
        </span>
      </span>
    </button>
  );
}

function Preview({ def, size }: { def: WidgetDef; size: WidgetSize }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ w: 520, h: 360 });
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() =>
      setRoom({ w: parent.clientWidth - 48, h: parent.clientHeight - 48 }),
    );
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const span = SIZES[size];
  const width = span.c * 240 + (span.c - 1) * GRID_GAP;
  const height = span.r * ROW_HEIGHT + (span.r - 1) * GRID_GAP;
  const scale = Math.max(0.2, Math.min(1, room.w / width, room.h / height));
  const Body = def.Body;
  const frame = {
    id: def.id,
    size,
    columns: 4,
    bodyHeight: bodyHeightFor(size, def.bare === true),
    preview: true,
  };
  const body = (
    <WidgetBoundary title={def.title}>
      <Body />
    </WidgetBoundary>
  );
  return (
    <div
      ref={ref}
      role="img"
      aria-label={`Preview of ${def.title}`}
      inert
      className="pointer-events-none relative"
      style={{ width: width * scale, height: height * scale }}
    >
      <div
        className="absolute top-0 left-0"
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: "0 0" }}
      >
        <WidgetFrameContext value={frame}>
          {def.bare ? (
            <div className="size-full overflow-hidden rounded-xl bg-card ring-1 ring-border/70">
              {body}
            </div>
          ) : (
            <section className="flex size-full flex-col overflow-hidden rounded-xl bg-card shadow-md/5 ring-1 ring-border/70">
              <WidgetHeading def={def} />
              <div className="@container relative min-h-0 flex-1 overflow-hidden px-1 pb-1.5">
                {body}
              </div>
            </section>
          )}
        </WidgetFrameContext>
      </div>
    </div>
  );
}
