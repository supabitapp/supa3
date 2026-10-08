import { useSyncExternalStore } from "react";

import type { WidgetTitles } from "../widgets/registry";
import { TILE_ENDPOINT, type TileRequest } from "./protocol";
import { decodeTileSpec, type TileSpec } from "./spec";

export interface TileRecord {
  readonly prompt: string;
  readonly raw: unknown;
  readonly spec: TileSpec | null;
  readonly drawing: boolean;
  readonly error: string | null;
}

const EMPTY: TileRecord = { prompt: "", raw: null, spec: null, drawing: false, error: null };
const STORAGE_KEY = "supacode:proto:new-thread:tiles";
const TIMEOUT_MS = 130_000;

function load(): Record<string, TileRecord> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(
      Object.entries(saved as Record<string, { prompt?: unknown; raw?: unknown }>).map(
        ([id, record]) => {
          const decoded = decodeTileSpec(record.raw);
          return [
            id,
            {
              ...EMPTY,
              prompt: typeof record.prompt === "string" ? record.prompt : "",
              raw: decoded.ok ? record.raw : null,
              spec: decoded.ok ? decoded.spec : null,
            },
          ];
        },
      ),
    );
  } catch {
    return {};
  }
}

let records = load();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  records = load();
  notify();
});

function persist() {
  const saved = Object.fromEntries(
    Object.entries(records).map(([id, record]) => [id, { prompt: record.prompt, raw: record.raw }]),
  );
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

function update(id: string, patch: Partial<TileRecord>) {
  records = { ...records, [id]: { ...(records[id] ?? EMPTY), ...patch } };
  if ("prompt" in patch || "raw" in patch) persist();
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTile(id: string): TileRecord {
  return useSyncExternalStore(subscribe, () => records[id] ?? EMPTY);
}

export const tileTitles: WidgetTitles = {
  subscribe,
  get: (id) => records[id]?.spec?.title ?? null,
};

export function forgetTile(id: string) {
  if (!records[id]) return;
  const { [id]: _forgotten, ...rest } = records;
  records = rest;
  persist();
  notify();
}

async function requestTile(request: TileRequest) {
  const response = await fetch(TILE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json()) as { spec?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `The request failed (${response.status}).`);
  return body.spec;
}

function describe(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "The agent took too long. Try again.";
  return error instanceof Error ? error.message : String(error);
}

export async function drawTile(id: string, request: TileRequest) {
  update(id, { prompt: request.prompt, drawing: true, error: null });
  try {
    const raw = await requestTile(request);
    const decoded = decodeTileSpec(raw);
    if (!decoded.ok)
      throw new Error(
        `The agent drew a tile that can't be shown: ${decoded.reason}. Try rewording.`,
      );
    if (records[id]) update(id, { raw, spec: decoded.spec, drawing: false });
  } catch (error) {
    if (records[id]) update(id, { drawing: false, error: describe(error) });
  }
}
