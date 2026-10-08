import {
  CheckIcon,
  EllipsisIcon,
  EyeOffIcon,
  GripVerticalIcon,
  LayoutGridIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { Button } from "../../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../../components/ui/menu";
import { cn } from "../../../lib/utils";
import { AddWidgetDialog } from "./AddWidgetDialog";
import { WidgetBoundary, WidgetHeading } from "./card";
import { WidgetEnvContext, WidgetFrameContext, bodyHeightFor, type WidgetEnv } from "./context";
import {
  DEFAULT_LAYOUT,
  GRID_GAP,
  ROW_HEIGHT,
  SIZES,
  SIZE_ORDER,
  addWidget,
  columnsFor,
  fitSize,
  moveWidget,
  readLayout,
  removeWidget,
  resizeWidget,
  stepSize,
  writeLayout,
  type Placed,
  type WidgetSize,
} from "./layout";
import { WIDGETS_BY_ID, type WidgetDef } from "./registry";

function readPositions(grid: HTMLElement) {
  const positions = new Map<string, { x: number; y: number }>();
  for (const cell of grid.querySelectorAll<HTMLElement>("[data-widget]")) {
    if (cell.dataset.widget) {
      positions.set(cell.dataset.widget, { x: cell.offsetLeft, y: cell.offsetTop });
    }
  }
  return positions;
}

const SPAN: Record<WidgetSize, string> = {
  s: "col-span-1 row-span-1",
  m: "col-span-2 row-span-1 @max-[480px]:col-span-1",
  t: "col-span-1 row-span-2",
  l: "col-span-2 row-span-2 @max-[480px]:col-span-1",
  w: "col-span-4 row-span-1 @max-[800px]:col-span-2 @max-[480px]:col-span-1",
};

export function WidgetGrid({ env }: { env: WidgetEnv }) {
  const [items, setItemsState] = useState(readLayout);
  const setItems = (next: Placed[]) => {
    setItemsState(next);
    writeLayout(next);
  };
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSession, setPickerSession] = useState(0);
  const openPicker = () => {
    setPickerSession((session) => session + 1);
    setPickerOpen(true);
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, announce] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(4);
  const handles = useRef(new Map<string, HTMLElement>());
  const positions = useRef(new Map<string, { x: number; y: number }>());

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      setColumns(columnsFor(el.clientWidth));
      positions.current = readPositions(el);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layoutColumns = useRef(columns);
  const measuredLayout = useRef("");
  const layoutKey = `${columns}|${items.map((p) => `${p.id}:${p.size}`).join(",")}`;
  useLayoutEffect(() => {
    const grid = wrapRef.current;
    if (!grid || measuredLayout.current === layoutKey) return;
    measuredLayout.current = layoutKey;
    const animate =
      layoutColumns.current === columns &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    layoutColumns.current = columns;
    const next = readPositions(grid);
    for (const cell of grid.querySelectorAll<HTMLElement>("[data-widget]")) {
      const id = cell.dataset.widget;
      const position = id ? next.get(id) : undefined;
      if (!id || !position) continue;
      const previous = positions.current.get(id);
      if (!animate || !previous) continue;
      const dx = previous.x - position.x;
      const dy = previous.y - position.y;
      if (dx === 0 && dy === 0) continue;
      for (const running of cell.getAnimations()) running.cancel();
      cell.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        {
          duration: 220,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        },
      );
    }
    positions.current = next;
  });

  useEffect(() => {
    if (!editing || pickerOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[data-slot=menu-popup]"))
        setEditing(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, pickerOpen]);

  const placed = items.filter((p) => WIDGETS_BY_ID.has(p.id));
  const titleOf = (id: string) => WIDGETS_BY_ID.get(id)?.title ?? "Widget";
  const focusHandle = (id: string | undefined) =>
    requestAnimationFrame(() => {
      if (id) handles.current.get(id)?.focus();
    });

  const onHandleKeyDown = (id: string, event: KeyboardEvent) => {
    const current = items;
    const index = current.findIndex((p) => p.id === id);
    const entry = current[index];
    const def = WIDGETS_BY_ID.get(id);
    if (!entry || !def) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = moveWidget(current, id, index + step);
      setItems(next);
      announce(`${def.title}, ${next.findIndex((p) => p.id === id) + 1} of ${next.length}`);
      focusHandle(id);
    } else if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      const size = stepSize(def.sizes, fitSize(def.sizes, entry.size), event.key === "[" ? -1 : 1);
      setItems(resizeWidget(current, id, size));
      announce(`${def.title}, ${SIZES[size].label.toLowerCase()}`);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const next = removeWidget(current, id);
      setItems(next);
      announce(`${def.title} removed`);
      focusHandle(next[Math.min(index, next.length - 1)]?.id);
    }
  };

  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const onHandlePointerDown = (id: string, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    drag.current = { id, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 5) return;
    if (!state.moved) {
      state.moved = true;
      setDragging(state.id);
    }
    const over = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-widget]")?.dataset.widget;
    if (!over || over === state.id) return;
    const target = items.findIndex((p) => p.id === over);
    if (target >= 0) setItems(moveWidget(items, state.id, target));
  };
  const onHandlePointerUp = () => {
    const state = drag.current;
    drag.current = null;
    setDragging(null);
    if (state?.moved) {
      const index = items.findIndex((p) => p.id === state.id);
      announce(`${titleOf(state.id)}, ${index + 1} of ${items.length}`);
    }
  };

  const reset = () => {
    writeLayout(null);
    setItemsState([...DEFAULT_LAYOUT]);
    announce("Widgets reset to the default set");
  };

  return (
    <WidgetEnvContext value={env}>
      <section aria-label="Widgets" className="flex flex-col gap-2.5">
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5">
          {editing ? (
            <>
              <div className="flex min-w-0 flex-1 flex-col">
                <h2 className="text-sm font-medium text-foreground">Customize</h2>
                <p id="widget-grid-hint" className="text-xs text-muted-foreground">
                  Drag a heading to move a widget, or focus it and use the arrow keys.{" "}
                  <kbd className="font-mono">[</kbd> <kbd className="font-mono">]</kbd> resize,
                  Delete removes. Saved as you go.
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={reset}>
                <RotateCcwIcon />
                Reset
              </Button>
              <Button size="sm" variant="outline" onClick={() => openPicker()}>
                <PlusIcon />
                Add widget
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                <CheckIcon />
                Done
              </Button>
            </>
          ) : (
            <>
              <span className="flex-1" />
              <Button size="sm" variant="ghost-muted" onClick={() => setEditing(true)}>
                <LayoutGridIcon />
                Customize
              </Button>
            </>
          )}
        </div>
        <div ref={wrapRef} className="@container">
          {placed.length === 0 ? (
            <EmptyGrid onAdd={() => openPicker()} onReset={reset} />
          ) : (
            <div
              role="list"
              aria-label="Widgets"
              className="grid grid-flow-row-dense grid-cols-4 @max-[800px]:grid-cols-2 @max-[480px]:grid-cols-1"
              style={{ gridAutoRows: ROW_HEIGHT, gap: GRID_GAP }}
            >
              {placed.map((p) => {
                const def = WIDGETS_BY_ID.get(p.id);
                if (!def) return null;
                return (
                  <WidgetCell
                    key={p.id}
                    def={def}
                    size={fitSize(def.sizes, p.size)}
                    columns={columns}
                    editing={editing}
                    dragging={dragging === p.id}
                    registerHandle={(el) => {
                      if (el) handles.current.set(p.id, el);
                      else handles.current.delete(p.id);
                    }}
                    onHandleKeyDown={(event) => onHandleKeyDown(p.id, event)}
                    onHandlePointerDown={(event) => onHandlePointerDown(p.id, event)}
                    onHandlePointerMove={onHandlePointerMove}
                    onHandlePointerUp={onHandlePointerUp}
                    onSize={(size) => {
                      setItems(resizeWidget(items, p.id, size));
                      announce(`${def.title}, ${SIZES[size].label.toLowerCase()}`);
                    }}
                    onRemove={() => {
                      setItems(removeWidget(items, p.id));
                      announce(`${def.title} removed`);
                    }}
                    onCustomize={() => setEditing(true)}
                  />
                );
              })}
              {editing ? (
                <div role="listitem" className="flex">
                  <button
                    type="button"
                    onClick={() => openPicker()}
                    className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-sm text-muted-foreground outline-none transition-colors duration-150 ease-out hover:border-border hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <PlusIcon className="size-4" />
                    Add widget
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        <AddWidgetDialog
          key={pickerSession}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          placed={placed.map((p) => p.id)}
          onAdd={(id, size) => {
            setItems(addWidget(items, id, size));
            setPickerOpen(false);
            announce(`${titleOf(id)} added`);
            requestAnimationFrame(() =>
              document
                .querySelector(`[data-widget="${CSS.escape(id)}"]`)
                ?.scrollIntoView({ block: "nearest" }),
            );
          }}
        />
      </section>
    </WidgetEnvContext>
  );
}

interface CellProps {
  def: WidgetDef;
  size: WidgetSize;
  columns: number;
  editing: boolean;
  dragging: boolean;
  registerHandle: (el: HTMLElement | null) => void;
  onHandleKeyDown: (event: KeyboardEvent) => void;
  onHandlePointerDown: (event: PointerEvent<HTMLElement>) => void;
  onHandlePointerMove: (event: PointerEvent<HTMLElement>) => void;
  onHandlePointerUp: () => void;
  onSize: (size: WidgetSize) => void;
  onRemove: () => void;
  onCustomize: () => void;
}

function WidgetCell({
  def,
  size,
  columns,
  editing,
  dragging,
  registerHandle,
  onHandleKeyDown,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onSize,
  onRemove,
  onCustomize,
}: CellProps) {
  const bare = def.bare === true && !editing;
  const headingId = `widget-${def.id}`;
  const Body = def.Body;
  const frame = {
    size,
    columns,
    bodyHeight: bodyHeightFor(size, bare),
    preview: false,
  };
  const body = (
    <WidgetBoundary title={def.title}>
      <Body />
    </WidgetBoundary>
  );

  return (
    <div
      role="listitem"
      data-widget={def.id}
      className={cn("relative min-h-0 min-w-0", SPAN[size])}
    >
      <WidgetFrameContext value={frame}>
        {bare ? (
          <section
            aria-label={def.title}
            className="group/w relative size-full overflow-hidden rounded-xl bg-card shadow-(--proto-card-shadow) ring-1 ring-border/60"
          >
            {body}
            <div className="absolute top-1.5 right-1.5 rounded-md bg-background/80 backdrop-blur-sm">
              <WidgetMenu
                def={def}
                size={size}
                onSize={onSize}
                onRemove={onRemove}
                onCustomize={onCustomize}
              />
            </div>
          </section>
        ) : (
          <section
            aria-labelledby={headingId}
            className={cn(
              "group/w relative flex size-full min-h-0 flex-col overflow-hidden rounded-xl bg-card",
              editing
                ? "outline-1 outline-dashed outline-border"
                : "shadow-(--proto-card-shadow) ring-1 ring-border/60",
              dragging && "z-10 shadow-(--proto-card-shadow-lifted) outline-2 outline-ring",
            )}
          >
            {editing ? (
              <div className="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-1">
                <button
                  ref={registerHandle}
                  type="button"
                  aria-label={`Move ${def.title}`}
                  aria-describedby="widget-grid-hint"
                  aria-roledescription="movable widget"
                  onKeyDown={onHandleKeyDown}
                  onPointerDown={onHandlePointerDown}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  onPointerCancel={onHandlePointerUp}
                  className="flex h-7 min-w-0 flex-1 cursor-grab touch-none items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                >
                  <GripVerticalIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span id={headingId} className="truncate text-xs font-medium text-foreground">
                    {def.title}
                  </span>
                </button>
                <SizeChips def={def} size={size} onSize={onSize} />
                <button
                  type="button"
                  aria-label={`Remove ${def.title}`}
                  onClick={onRemove}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ) : (
              <WidgetHeading
                def={def}
                id={headingId}
                actions={
                  <WidgetMenu
                    def={def}
                    size={size}
                    onSize={onSize}
                    onRemove={onRemove}
                    onCustomize={onCustomize}
                  />
                }
              />
            )}
            <div
              className={cn(
                "@container relative min-h-0 flex-1 overflow-hidden px-1 pb-1.5",
                editing && "pointer-events-none select-none",
              )}
              inert={editing}
            >
              {body}
            </div>
          </section>
        )}
      </WidgetFrameContext>
    </div>
  );
}

function WidgetMenu(props: {
  def: WidgetDef;
  size: WidgetSize;
  onSize: (size: WidgetSize) => void;
  onRemove: () => void;
  onCustomize: () => void;
}) {
  const { def, size } = props;
  return (
    <Menu>
      <span className="inline-flex opacity-0 transition-opacity duration-150 ease-out group-focus-within/w:opacity-100 group-hover/w:opacity-100 pointer-coarse:opacity-100 has-data-popup-open:opacity-100">
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`${def.title} options`}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
      </span>
      <MenuPopup align="end" className="min-w-48">
        {def.sizes.length > 1 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Size</MenuGroupLabel>
              <MenuRadioGroup
                value={size}
                onValueChange={(value) => props.onSize(value as WidgetSize)}
              >
                {SIZE_ORDER.filter((s) => def.sizes.includes(s)).map((s) => (
                  <MenuRadioItem key={s} value={s}>
                    <span className="flex w-full items-center gap-3">
                      {SIZES[s].label}
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {SIZES[s].c}×{SIZES[s].r}
                      </span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onClick={props.onCustomize}>
          <LayoutGridIcon />
          Customize
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={props.onRemove}>
          <EyeOffIcon />
          Remove
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SizeChips(props: {
  def: WidgetDef;
  size: WidgetSize;
  onSize: (size: WidgetSize) => void;
}) {
  if (props.def.sizes.length < 2) return null;
  return (
    <div
      role="group"
      aria-label={`${props.def.title} size`}
      className="flex shrink-0 items-center rounded-md border bg-background p-0.5"
    >
      {SIZE_ORDER.filter((s) => props.def.sizes.includes(s)).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === props.size}
          aria-label={`${SIZES[s].label}, ${SIZES[s].c} by ${SIZES[s].r}`}
          onClick={() => props.onSize(s)}
          className={cn(
            "h-5 min-w-6 rounded-sm px-1 font-mono text-3xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
            s === props.size
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function EmptyGrid(props: { onAdd: () => void; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
      <h3 className="text-sm font-medium text-foreground">No widgets here</h3>
      <p className="max-w-sm text-sm text-balance text-muted-foreground">
        Put what you check first above the prompt: agents that need you, pull requests, what's
        running.
      </p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={props.onAdd}>
          <PlusIcon />
          Add a widget
        </Button>
        <Button size="sm" variant="outline" onClick={props.onReset}>
          <RotateCcwIcon />
          Restore the default
        </Button>
      </div>
    </div>
  );
}
