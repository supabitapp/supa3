import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { seededRandom } from "../data";
import { useWidgetFrame } from "./context";

export type Tone = "" | "faint" | "soft" | "mid" | "ink" | "strong" | "light" | "alert" | "good";

const TONE: Record<Tone, string> = {
  "": "",
  faint: "text-muted-foreground/35",
  soft: "text-muted-foreground/60",
  mid: "text-muted-foreground",
  ink: "text-foreground/75",
  strong: "text-foreground",
  light: "text-warning",
  alert: "text-warning-foreground",
  good: "text-success",
};

const CONTOUR = ["_", ".", "-", "'"];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const dither = (row: number, col: number, level: number) =>
  level > (BAYER[(row % 4) * 4 + (col % 4)]! + 0.5) / 16;

export class Canvas {
  readonly chars: string[][];
  readonly tones: Tone[][];
  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.chars = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
    this.tones = Array.from({ length: rows }, () => Array<Tone>(cols).fill(""));
  }
  inside(row: number, col: number) {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }
  get(row: number, col: number) {
    return this.inside(row, col) ? this.chars[row]![col]! : " ";
  }
  set(row: number, col: number, char: string, tone: Tone) {
    if (!this.inside(row, col)) return;
    this.chars[row]![col] = char;
    this.tones[row]![col] = tone;
  }
  text(row: number, col: number, text: string, tone: Tone) {
    [...text].forEach((char, i) => this.set(row, col + i, char, tone));
  }
  sprite(
    row: number,
    col: number,
    lines: ReadonlyArray<string>,
    tone: Tone,
    accents?: Partial<Record<string, Tone>>,
    solid = false,
  ) {
    lines.forEach((line, r) => {
      const start = line.search(/\S/);
      const end = line.trimEnd().length;
      [...line].forEach((char, c) => {
        if (char !== " ") this.set(row + r, col + c, char, accents?.[char] ?? tone);
        else if (solid && c > start && c < end) this.set(row + r, col + c, " ", "");
      });
    });
  }
  ridge(
    base: number,
    levels: ReadonlyArray<number>,
    edge: Tone,
    fill?: { char: string; tone: Tone; density: (depth: number) => number },
  ) {
    for (let c = 0; c < this.cols; c++) {
      const from = levels[c] ?? 0;
      const to = levels[c + 1] ?? from;
      const low = base - Math.min(from, to);
      for (let r = low + 1; r <= base; r++) {
        const depth = r - low;
        if (fill && dither(r, c, fill.density(depth))) this.set(r, c, fill.char, fill.tone);
        else this.set(r, c, " ", "");
      }
      if (from === to) this.set(low, c, "_", edge);
      for (let level = Math.min(from, to); level < Math.max(from, to); level++)
        this.set(base - level, c, to > from ? "/" : "\\", edge);
    }
  }
  clear(row: number, col: number, height: number, width: number) {
    for (let r = row; r < row + height; r++)
      for (let c = col; c < col + width; c++) this.set(r, c, " ", "");
  }
  contour(
    base: number,
    heights: ReadonlyArray<number>,
    edge: Tone,
    fill?: { char: string; tone: Tone; density: number },
  ) {
    heights.forEach((height, c) => {
      const row = base - Math.floor(height);
      const frac = height - Math.floor(height);
      this.set(row, c, CONTOUR[Math.floor(frac * CONTOUR.length)]!, edge);
      for (let r = row + 1; r <= base; r++) {
        if (fill && dither(r, c, fill.density)) this.set(r, c, fill.char, fill.tone);
        else this.set(r, c, " ", "");
      }
    });
  }
  render() {
    return this.chars.map((row, r) => {
      const runs: Array<{ id: string; text: string; tone: Tone }> = [];
      row.forEach((char, c) => {
        const tone = this.tones[r]![c]!;
        const last = runs.at(-1);
        if (last && (last.tone === tone || char === " ")) last.text += char;
        else runs.push({ id: `${r}:${c}`, text: char, tone });
      });
      return { id: `row-${r}`, runs };
    });
  }
}

export function truncate(text: string, max: number) {
  if (max <= 1) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface ArtHit {
  readonly key: string;
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly onClick: () => void;
}

const SEEDS_KEY = "supacode:proto:new-thread:art-seeds";

function readSeeds(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(SEEDS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function useArtSeed(id: string) {
  const [seed, setSeed] = useState(() => readSeeds()[id] ?? id);
  const reroll = () => {
    const next = Math.random().toString(36).slice(2, 8);
    setSeed(next);
    window.localStorage.setItem(SEEDS_KEY, JSON.stringify({ ...readSeeds(), [id]: next }));
  };
  return [seed, reroll] as const;
}

const LINE_HEIGHT = 12;
const PROBE = 40;

export function AsciiArt(props: {
  id: string;
  title: string;
  caption: ReactNode;
  draw: (canvas: Canvas, rand: () => number) => ReadonlyArray<ArtHit> | void;
}) {
  const { preview } = useWidgetFrame();
  const [seed, reroll] = useArtSeed(props.id);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<{ cols: number; rows: number; charWidth: number } | null>(null);

  useLayoutEffect(() => {
    const element = boxRef.current;
    const probe = probeRef.current;
    if (!element || !probe) return;
    const measure = () => {
      const charWidth = probe.offsetWidth / PROBE;
      if (charWidth <= 0) return;
      setBox({
        cols: Math.max(8, Math.floor(element.offsetWidth / charWidth)),
        rows: Math.max(3, Math.floor(element.offsetHeight / LINE_HEIGHT)),
        charWidth,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const canvas = box ? new Canvas(box.cols, box.rows) : null;
  const hits = canvas ? (props.draw(canvas, seededRandom(`${props.id}:${seed}`)) ?? []) : [];
  const lines = canvas?.render() ?? [];

  return (
    <div className="group/art flex h-full flex-col gap-1 px-3 pb-2">
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden">
        <span
          ref={probeRef}
          aria-hidden
          className="invisible absolute font-mono text-2xs whitespace-pre"
        >
          {"M".repeat(PROBE)}
        </span>
        <button
          type="button"
          aria-label={`Draw ${props.title} again`}
          tabIndex={preview ? -1 : undefined}
          onClick={reroll}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <pre
          aria-hidden
          className="pointer-events-none relative m-0 font-mono text-2xs select-none"
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        >
          {lines.map((line) => (
            <div key={line.id}>
              {line.runs.map((run) => (
                <span key={run.id} className={run.tone ? TONE[run.tone] : undefined}>
                  {run.text}
                </span>
              ))}
            </div>
          ))}
        </pre>
        {box
          ? hits.map((hit) => (
              <button
                key={hit.key}
                type="button"
                aria-label={hit.label}
                tabIndex={preview ? -1 : undefined}
                onClick={hit.onClick}
                className="absolute rounded-md outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]"
                style={{
                  top: hit.row * LINE_HEIGHT,
                  left: hit.col * box.charWidth,
                  width: hit.width * box.charWidth,
                  height: hit.height * LINE_HEIGHT,
                }}
              />
            ))
          : null}
      </div>
      <div className="relative h-4 text-xs">
        <p className="truncate text-muted-foreground">{props.caption}</p>
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 right-0 bg-card pl-3 text-secondary-label opacity-0 transition-opacity duration-150",
            "group-hover/art:opacity-100 group-focus-within/art:opacity-100",
          )}
        >
          Click to redraw
        </span>
      </div>
    </div>
  );
}
