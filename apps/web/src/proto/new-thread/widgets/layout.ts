export type WidgetSize = "s" | "m" | "t" | "l" | "w";

export const SIZES: Record<WidgetSize, { c: number; r: number; label: string }> = {
  s: { c: 1, r: 1, label: "Small" },
  m: { c: 2, r: 1, label: "Medium" },
  t: { c: 1, r: 2, label: "Tall" },
  l: { c: 2, r: 2, label: "Large" },
  w: { c: 4, r: 1, label: "Wide" },
};

export const SIZE_ORDER: ReadonlyArray<WidgetSize> = ["s", "m", "t", "l", "w"];

export const ROW_HEIGHT = 176;
export const GRID_GAP = 12;
export const HEADING_HEIGHT = 36;

export interface Placed {
  readonly id: string;
  readonly size: WidgetSize;
}

export const DEFAULT_LAYOUT: ReadonlyArray<Placed> = [
  { id: "needs-you", size: "m" },
  { id: "working", size: "m" },
  { id: "starters", size: "m" },
  { id: "pull-requests", size: "m" },
  { id: "finished", size: "m" },
  { id: "services", size: "s" },
  { id: "harbor", size: "w" },
];

const STORAGE_KEY = "supacode:proto:new-thread:widgets";
const isSize = (value: unknown): value is WidgetSize => typeof value === "string" && value in SIZES;

export function readLayout(): Placed[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(raw)) return [...DEFAULT_LAYOUT];
    const seen = new Set<string>();
    return raw.flatMap((entry: { id?: unknown; size?: unknown }) => {
      if (typeof entry?.id !== "string" || seen.has(entry.id)) return [];
      seen.add(entry.id);
      return [{ id: entry.id, size: isSize(entry.size) ? entry.size : "m" }];
    });
  } catch {
    return [...DEFAULT_LAYOUT];
  }
}

export function writeLayout(items: ReadonlyArray<Placed> | null) {
  if (items === null) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function fitSize(allowed: ReadonlyArray<WidgetSize>, size: WidgetSize): WidgetSize {
  if (allowed.includes(size)) return size;
  const distance = (s: WidgetSize) =>
    Math.abs(SIZES[s].c - SIZES[size].c) + Math.abs(SIZES[s].r - SIZES[size].r);
  return [...allowed].sort((a, b) => distance(a) - distance(b))[0] ?? size;
}

export function stepSize(
  allowed: ReadonlyArray<WidgetSize>,
  current: WidgetSize,
  direction: 1 | -1,
): WidgetSize {
  const area = (s: WidgetSize) => SIZES[s].c * SIZES[s].r * 10 + SIZES[s].c;
  const sorted = [...allowed].sort((a, b) => area(a) - area(b));
  const index = sorted.indexOf(current);
  return sorted[Math.max(0, Math.min(sorted.length - 1, index + direction))] ?? current;
}

export const addWidget = (items: ReadonlyArray<Placed>, id: string, size: WidgetSize) =>
  items.some((p) => p.id === id) ? [...items] : [...items, { id, size }];

export const removeWidget = (items: ReadonlyArray<Placed>, id: string) =>
  items.filter((p) => p.id !== id);

export const resizeWidget = (items: ReadonlyArray<Placed>, id: string, size: WidgetSize) =>
  items.map((p) => (p.id === id ? { ...p, size } : p));

export function moveWidget(items: ReadonlyArray<Placed>, id: string, index: number): Placed[] {
  const from = items.findIndex((p) => p.id === id);
  if (from < 0) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(Math.max(0, Math.min(next.length, index)), 0, moved);
  return next;
}

export const columnsFor = (width: number): 1 | 2 | 4 => (width >= 800 ? 4 : width >= 480 ? 2 : 1);
