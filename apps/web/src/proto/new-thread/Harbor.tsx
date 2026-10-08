import { useLayoutEffect, useRef, useState } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  IN_FLIGHT,
  NEEDS_YOU,
  seededRandom,
  useOpenThread,
  type ProtoData,
  type ProtoThread,
} from "./data";

type Ink =
  | ""
  | "sky"
  | "star"
  | "sun"
  | "land"
  | "water"
  | "boat"
  | "alert"
  | "done"
  | "dock"
  | "label"
  | "lamp";

const INK: Record<Ink, string> = {
  "": "",
  sky: "text-muted-foreground/45",
  star: "text-muted-foreground/70",
  sun: "text-foreground/80",
  land: "text-muted-foreground/70",
  water: "text-muted-foreground/40",
  boat: "text-foreground",
  alert: "text-warning-foreground",
  done: "text-success",
  dock: "text-muted-foreground",
  label: "text-foreground/75",
  lamp: "text-warning",
};

const STATUS_LABEL: Record<ProtoThread["status"], string> = {
  approval: "Needs approval",
  input: "Needs your answer",
  failed: "Failed",
  limited: "Hit a usage limit",
  working: "Working",
  waiting: "Waiting on background work",
  ready: "Finished",
};

const SCENE_ROWS = 17;
const MAX_ROWS = 44;
const LINE_HEIGHT = 16;
const LABEL_CHARS = 18;
const SLOT = 7 + 2 + LABEL_CHARS + 3;

const SAIL = ["  |\\   ", "  | \\  ", "__|__\\_", "\\_____/"];
const FLAGGED = ["  |>!  ", "  |\\   ", "__|_\\__", "\\_____/"];
const MOORED = ["  |    ", "  |    ", "__|____", "\\_____/"];

interface Hit {
  readonly thread: ProtoThread;
  readonly row: number;
  readonly col: number;
  readonly width: number;
}

class Grid {
  readonly chars: string[][];
  readonly inks: Ink[][];
  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.chars = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
    this.inks = Array.from({ length: rows }, () => Array<Ink>(cols).fill(""));
  }
  set(row: number, col: number, char: string, ink: Ink) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    this.chars[row]![col] = char;
    this.inks[row]![col] = ink;
  }
  text(row: number, col: number, text: string, ink: Ink) {
    [...text].forEach((char, i) => this.set(row, col + i, char, ink));
  }
  sprite(
    row: number,
    col: number,
    lines: ReadonlyArray<string>,
    ink: Ink,
    accents?: Record<string, Ink>,
  ) {
    lines.forEach((line, r) => {
      const start = line.search(/\S/);
      const end = line.trimEnd().length;
      if (start < 0) return;
      for (let i = start; i < end; i++) {
        const char = line[i]!;
        this.set(row + r, col + i, char, accents?.[char] ?? ink);
      }
    });
  }
  render() {
    return this.chars.map((row, r) => {
      const runs: Array<{ id: string; text: string; ink: Ink }> = [];
      row.forEach((char, c) => {
        const ink = this.inks[r]![c]!;
        const last = runs.at(-1);
        if (last && last.ink === ink) last.text += char;
        else runs.push({ id: `${r}:${c}`, text: char, ink });
      });
      return { id: `row-${r}`, runs };
    });
  }
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function buildScene(input: {
  cols: number;
  rows: number;
  seed: string;
  hour: number;
  atSea: ReadonlyArray<ProtoThread>;
  atPier: ReadonlyArray<ProtoThread>;
}) {
  const { cols, rows } = input;
  const rand = seededRandom(input.seed);
  const grid = new Grid(cols, rows);
  const night = input.hour < 6 || input.hour >= 19;
  const lighthouseCol = cols - 14;
  const top = rows - SCENE_ROWS;
  const at = (row: number) => top + row;

  const hasSky = at(4) >= 3;
  if (hasSky && night) {
    for (let r = 0; r < at(4); r++) {
      const density = 0.012 + 0.02 * (r / Math.max(1, at(4)));
      for (let c = 0; c < cols; c++) {
        if (rand() < density)
          grid.set(r, c, ["·", ".", "*", "+", "."][Math.floor(rand() * 5)]!, "star");
      }
    }
    grid.sprite(
      Math.max(0, at(0) - Math.floor(top * 0.6)),
      Math.floor(cols * 0.6),
      [" .-.", "(  (", " '-'"],
      "sun",
    );
  } else if (hasSky) {
    grid.sprite(
      Math.max(0, at(0) - Math.floor(top * 0.6)),
      Math.floor(cols * 0.6),
      [" \\ | /", "-- O --", " / | \\"],
      "sun",
    );
    const clouds = Math.max(1, Math.floor(cols / 55)) + Math.floor(top / 8);
    for (let i = 0; i < clouds; i++) {
      grid.sprite(
        Math.floor(rand() * Math.max(1, at(2))),
        Math.floor(rand() * (cols * 0.55)),
        ["  .-~~-.", " (      )-.", "  `-..-`--'"],
        "sky",
      );
    }
  }

  for (let c = 0; c < cols; c++) grid.set(at(4), c, "_", "land");
  const peaks = Math.max(3, Math.floor(cols / 14));
  for (let i = 0; i < peaks; i++) {
    const peak = Math.floor(rand() * cols);
    if (Math.abs(peak - lighthouseCol) < 8) continue;
    const height = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < height; k++) {
      const row = at(4) - height + 1 + k;
      for (let c = peak - k; c <= peak + 1 + k; c++) grid.set(row, c, " ", "");
      grid.set(row, peak - k, "/", "land");
      grid.set(row, peak + 1 + k, "\\", "land");
    }
  }

  const lit = input.atSea.length > 0;
  grid.sprite(at(0), lighthouseCol, ["  /\\", " |**|", " |  |", " |__|"], "dock", {
    "*": lit ? "lamp" : "dock",
  });
  if (lit) grid.text(at(1), lighthouseCol - 9, "- -- ---", "lamp");

  for (let r = at(5); r < rows; r++) {
    const density = r === at(5) ? 0.5 : r === at(6) ? 0.28 : 0.13;
    for (let c = 0; c < cols; c++) {
      if (rand() < density / 2) {
        const wave = ["~", "~~", "-~", "~-~", "."][Math.floor(rand() * 5)]!;
        grid.text(r, c, wave, "water");
        c += wave.length;
      }
    }
  }

  const hits: Hit[] = [];
  const clear = (row: number, col: number, height: number, width: number) => {
    for (let r = row; r < row + height; r++)
      for (let c = col; c < col + width; c++) grid.set(r, c, " ", "");
  };
  const place = (
    thread: ProtoThread,
    row: number,
    col: number,
    sprite: ReadonlyArray<string>,
    ink: Ink,
  ) => {
    const label = truncate(thread.title, LABEL_CHARS);
    clear(row, col - 1, 4, 7 + 2 + label.length + 2);
    grid.sprite(row, col, sprite, "boat", { "!": "alert", ">": ink });
    grid.text(row + 1, col + 9, label, "label");
    hits.push({ thread, row, col: col - 1, width: 7 + 2 + label.length + 2 });
  };

  const seaCapacity = Math.max(1, Math.floor((cols - 18) / SLOT));
  input.atSea
    .slice(0, seaCapacity)
    .forEach((thread, i) => place(thread, at(6), 2 + i * SLOT, SAIL, "boat"));
  if (input.atSea.length > seaCapacity) {
    const more = `+${input.atSea.length - seaCapacity} more`;
    clear(at(7), 2 + seaCapacity * SLOT - 1, 1, more.length + 2);
    grid.text(at(7), 2 + seaCapacity * SLOT, more, "label");
  }

  const pierLength = Math.min(30, Math.floor(cols * 0.24));
  for (let c = 0; c < pierLength; c++) grid.set(at(13), c, "=", "dock");
  for (let c = 1; c < pierLength; c += 5)
    for (let r = at(14); r < rows; r++) grid.set(r, c, "|", "dock");
  const someoneNeedsYou = input.atPier.some((t) => NEEDS_YOU.has(t.status));
  clear(at(10), pierLength - 7, 3, 5);
  grid.sprite(
    at(10),
    pierLength - 6,
    someoneNeedsYou ? ["\\o/", " | ", "/ \\"] : [" o ", "/|\\", "/ \\"],
    "boat",
  );

  const pierCapacity = Math.max(1, Math.floor((cols - pierLength - 4) / SLOT));
  input.atPier.slice(0, pierCapacity).forEach((thread, i) => {
    const waiting = NEEDS_YOU.has(thread.status);
    place(
      thread,
      at(11),
      pierLength + 2 + i * SLOT,
      waiting ? FLAGGED : MOORED,
      waiting ? "alert" : "done",
    );
    if (!waiting && thread.unread) grid.set(at(11), pierLength + 2 + i * SLOT + 3, "✓", "done");
  });

  return { lines: grid.render(), hits };
}

function harborCrew(data: ProtoData) {
  const atSea = data.projectThreads.filter((t) => IN_FLIGHT.has(t.status));
  const waiting = data.projectThreads.filter((t) => NEEDS_YOU.has(t.status));
  const back = data.projectThreads.filter((t) => t.status === "ready").slice(0, 3);
  return { atSea, waiting, back, atPier: [...waiting, ...back] };
}

export function harborCaption(data: ProtoData): string {
  const { atSea, waiting, back } = harborCrew(data);
  const unread = back.filter((t) => t.unread).length;
  return [
    atSea.length > 0 ? `${atSea.length} out at sea` : "Calm water, nothing out",
    waiting.length > 0 ? `${waiting.length} waiting on you at the pier` : null,
    unread > 0 ? `${unread} back since you last looked` : `${back.length} in port`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function HarborScene({
  data,
  sizing,
  className,
}: {
  data: ProtoData;
  sizing: "host" | "box";
  className?: string;
}) {
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [metrics, setMetrics] = useState<{ cols: number; rows: number; charWidth: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const probe = probeRef.current;
    const host = sizing === "host" ? wrapper?.closest<HTMLElement>("[data-proto-layer]") : wrapper;
    if (!wrapper || !probe || !host) return;
    const measure = () => {
      const charWidth = probe.offsetWidth / 50;
      if (charWidth <= 0) return;
      const rows =
        sizing === "host"
          ? Math.min(
              MAX_ROWS,
              Math.max(SCENE_ROWS, Math.floor((host.clientHeight - 40) / LINE_HEIGHT)),
            )
          : Math.max(6, Math.floor(host.clientHeight / LINE_HEIGHT));
      setMetrics({ cols: Math.floor(wrapper.clientWidth / charWidth), rows, charWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    if (host !== wrapper) observer.observe(host);
    return () => observer.disconnect();
  }, [sizing]);

  const { atSea, atPier } = harborCrew(data);
  const hour = new Date(now).getHours();
  const seed = data.project ? `${data.project.environmentId}:${data.project.id}` : "harbor";

  const scene = metrics
    ? buildScene({ cols: metrics.cols, rows: metrics.rows, seed, hour, atSea, atPier })
    : null;

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <span
        ref={probeRef}
        aria-hidden
        className="invisible absolute font-mono text-xs whitespace-pre"
      >
        {"M".repeat(50)}
      </span>
      {scene && metrics ? (
        <>
          <pre
            aria-hidden
            data-proto-harbor-reveal=""
            className="m-0 overflow-hidden font-mono text-xs select-none"
            style={{ lineHeight: `${LINE_HEIGHT}px` }}
          >
            {scene.lines.map((line) => (
              <div key={line.id}>
                {line.runs.map((run) => (
                  <span key={run.id} className={run.ink ? INK[run.ink] : undefined}>
                    {run.text}
                  </span>
                ))}
              </div>
            ))}
          </pre>
          {scene.hits
            .filter((hit) => hit.row >= 0 && hit.row < metrics.rows)
            .map((hit) => (
              <button
                key={hit.thread.key}
                type="button"
                aria-label={`${STATUS_LABEL[hit.thread.status]}: ${hit.thread.title}`}
                onClick={() => openThread(hit.thread)}
                className="absolute rounded-md outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]"
                style={{
                  top: hit.row * LINE_HEIGHT - 2,
                  left: hit.col * metrics.charWidth,
                  width: hit.width * metrics.charWidth,
                  height: 4 * LINE_HEIGHT + 4,
                }}
              />
            ))}
        </>
      ) : sizing === "host" ? (
        <div style={{ height: SCENE_ROWS * LINE_HEIGHT }} />
      ) : null}
    </div>
  );
}

export function Harbor({ data }: { data: ProtoData }) {
  return (
    <div className="chat-composer-lane flex min-h-full flex-col justify-end">
      <div className="mx-auto w-full max-w-5xl pb-1">
        <HarborScene data={data} sizing="host" />
        <p className="mt-2 text-center text-xs text-muted-foreground">{harborCaption(data)}</p>
      </div>
    </div>
  );
}
