import { scopeProjectRef } from "@supacode/client-runtime/environment";

import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useNowMinuteMs } from "../../../hooks/useNowMinute";
import { useProjects } from "../../../state/entities";
import {
  DAY_MS,
  IN_FLIGHT,
  NEEDS_YOU,
  countPerDay,
  seededRandom,
  type ProtoData,
  type ProtoThread,
} from "../data";
import { startOfDay } from "../Pulse";
import { useLimitRows } from "./appWidgets";
import { AsciiArt, Canvas, truncate, type ArtHit, type Tone } from "./ascii";
import { useWidgetEnv, useWidgetFrame } from "./context";
import type { WidgetSize } from "./layout";
import { WidgetEmpty } from "./scenes";

const weekdayDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const resetDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const resetTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function isNight(now: number) {
  const hour = new Date(now).getHours();
  return hour < 6 || hour >= 19;
}

function starfield(canvas: Canvas, rand: () => number, bottom: number, density: number) {
  for (let r = 0; r < bottom; r++)
    for (let c = 0; c < canvas.cols; c++)
      if (rand() < density) canvas.set(r, c, rand() < 0.8 ? "." : "'", "faint");
}

function hills(canvas: Canvas, rand: () => number, amplitude: number) {
  const [phaseA, phaseB] = [rand() * Math.PI * 2, rand() * Math.PI * 2];
  const [waveA, waveB] = [30 + rand() * 30, 9 + rand() * 8];
  const heights = Array.from({ length: canvas.cols }, (_, c) =>
    Math.max(
      0,
      amplitude *
        (0.45 +
          0.35 * Math.sin((c / waveA) * Math.PI * 2 + phaseA) +
          0.15 * Math.sin((c / waveB) * Math.PI * 2 + phaseB)),
    ),
  );
  canvas.contour(canvas.rows - 1, heights, "soft", { char: ".", tone: "faint", density: 0.2 });
}

const startsPerDay = (threads: ReadonlyArray<ProtoThread>, today: number, days: number) =>
  countPerDay(
    threads.map((t) => t.createdAt),
    today,
    days,
  );

const sum = (values: ReadonlyArray<number>) => values.reduce((a, b) => a + b, 0);

type Sky = "clear" | "cloudy" | "rain" | "storm";
const SKY_LABEL: Record<Sky, string> = {
  clear: "Clear",
  cloudy: "Clouds",
  rain: "Rain",
  storm: "Storm",
};
const SUN = [" \\ | /", "-- O --", " / | \\"];
const CRESCENT = [" .-.", "(  (", " '-'"];
const CLOUDS = [
  ["   .--.", ".-(    ).", "(___.__)_)"],
  ["  .-~~-.", " (      )", "(___.____)"],
];
const CLOUD_TONE: Record<Sky, Tone> = { clear: "soft", cloudy: "soft", rain: "mid", storm: "ink" };
const BOLT = ["  /", " /_", "  /"];
const WIND = ["~~", "- ~", "~ -~", "-~"];

function forecastOf(data: ProtoData) {
  const waiting = data.threads.filter((t) => NEEDS_YOU.has(t.status)).length;
  const failed = data.threads.filter((t) => t.status === "failed").length;
  const working = data.threads.filter((t) => IN_FLIGHT.has(t.status)).length;
  let sky: Sky = "clear";
  if (failed >= 2 || (failed === 1 && waiting >= 4)) sky = "storm";
  else if (failed === 1 || waiting >= 3) sky = "rain";
  else if (waiting > 0) sky = "cloudy";
  return { sky, waiting, failed, working };
}

function drawForecast(
  canvas: Canvas,
  rand: () => number,
  forecast: ReturnType<typeof forecastOf>,
  night: boolean,
) {
  const { cols, rows } = canvas;
  const ground = rows - 1;
  const covered = forecast.sky === "rain" || forecast.sky === "storm";
  const lampCol = Math.max(0, Math.floor(cols * (0.6 + rand() * 0.2)) - 3);

  if (night && !covered) starfield(canvas, rand, ground - 1, 0.025);
  if (!covered && night) canvas.sprite(0, lampCol + 2, CRESCENT, "ink", undefined, true);
  if (!covered && !night) canvas.sprite(0, lampCol, SUN, "light", undefined, true);

  const perSky: Record<Sky, number> = { clear: rand() < 0.5 ? 1 : 0, cloudy: 2, rain: 3, storm: 4 };
  const count = perSky[forecast.sky] * Math.max(1, Math.round(cols / 50));
  const clouds = Array.from({ length: count }, (_, i) => {
    const shape = CLOUDS[Math.floor(rand() * CLOUDS.length)]!;
    const width = shape[1]!.length;
    const overSun = forecast.sky === "cloudy" && i === 0;
    return {
      shape,
      width,
      col: overSun ? lampCol - 4 : Math.floor(rand() * Math.max(1, cols - width)),
      row: overSun ? 1 : Math.floor(rand() * Math.max(1, Math.min(3, rows - 6))),
    };
  });

  if (covered) {
    const density = forecast.sky === "storm" ? 0.3 : 0.18;
    const drop = forecast.working > 0 ? "/" : "'";
    for (const cloud of clouds)
      for (let r = cloud.row + 3; r < ground; r++)
        for (let c = cloud.col + 1; c < cloud.col + cloud.width - 1; c++)
          if (rand() < density) canvas.set(r, c, drop, "soft");
  }
  for (const cloud of clouds)
    canvas.sprite(cloud.row, cloud.col, cloud.shape, CLOUD_TONE[forecast.sky], {}, true);
  const bolt = clouds[0];
  if (forecast.sky === "storm" && bolt)
    canvas.sprite(bolt.row + 3, bolt.col + 3, BOLT, "alert", undefined, true);

  if (!covered) {
    for (let i = 0; i < Math.min(forecast.working, 4); i++) {
      const streak = WIND[Math.floor(rand() * WIND.length)]!;
      const row = 1 + Math.floor(rand() * Math.max(1, ground - 3));
      const col = Math.floor(rand() * Math.max(1, cols - streak.length));
      const blank = [...streak].every((_, k) => canvas.get(row, col + k) === " ");
      if (blank) canvas.text(row, col, streak, "faint");
    }
  }
  hills(canvas, rand, rows >= 8 ? 2 : 1);
}

export function ForecastBody() {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const forecast = forecastOf(data);
  const night = isNight(now);
  const caption = [
    SKY_LABEL[forecast.sky],
    forecast.waiting > 0 ? `${forecast.waiting} waiting on you` : "nothing needs you",
    forecast.failed > 0 ? `${forecast.failed} failed` : null,
    forecast.working > 0 ? `${plural(forecast.working, "agent")} out` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AsciiArt
      id="forecast"
      title="Forecast"
      caption={caption}
      draw={(canvas, rand) => drawForecast(canvas, rand, forecast, night)}
    />
  );
}

const GARDEN_DAYS: Record<WidgetSize, number> = { s: 10, t: 10, m: 21, l: 21, w: 30 };

function drawGarden(
  canvas: Canvas,
  rand: () => number,
  garden: { starts: ReadonlyArray<number>; blooms: ReadonlyArray<boolean> },
) {
  const { cols, rows } = canvas;
  const days = garden.starts.length;
  const ground = rows - 2;
  const spacing = Math.max(2, Math.min(6, Math.floor((cols - 1) / days)));
  const offset = cols - days * spacing;
  const max = Math.max(4, ...garden.starts);

  for (let c = 0; c < cols; c++) {
    canvas.set(ground, c, "_", "mid");
    if (rand() < 0.3) canvas.set(rows - 1, c, rand() < 0.6 ? "." : ",", "faint");
  }
  garden.starts.forEach((count, i) => {
    const x = offset + i * spacing + Math.floor(spacing / 2);
    const today = i === days - 1;
    const bloom = garden.blooms[i] === true;
    const stem: Tone = today ? "strong" : "soft";
    const leaf: Tone = today ? "ink" : "mid";
    if (today) canvas.set(rows - 1, x, "^", "mid");
    if (count === 0) return;
    const height = Math.max(1, Math.round(Math.sqrt(count / max) * (ground + 1)));
    const top = ground - height + 1;
    for (let r = top + 1; r <= ground; r++) {
      canvas.set(r, x, "|", stem);
      if (r === ground || spacing < 3) continue;
      const side = rand();
      if (side < 0.3) canvas.set(r, x - 1, "\\", leaf);
      else if (side < 0.6) canvas.set(r, x + 1, "/", leaf);
    }
    if (bloom) canvas.set(top, x, "@", "light");
    else canvas.set(top, x, height === 1 ? "v" : "Y", leaf);
  });
}

export function GardenBody() {
  const { data } = useWidgetEnv();
  const { size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const today = startOfDay(now);
  const days = GARDEN_DAYS[size];
  const starts = startsPerDay(data.projectThreads, today, days);
  const blooms = countPerDay(
    data.projectThreads.flatMap((t) =>
      t.prs.filter((pr) => pr.state === "merged").map((pr) => pr.updatedAt),
    ),
    today,
    days,
  ).map((merged) => merged > 0);
  const bloomDays = blooms.filter(Boolean).length;
  const caption = [
    `${plural(sum(starts), "thread")} in ${days} days`,
    bloomDays > 0 ? `${plural(bloomDays, "day")} in bloom` : null,
    `${starts.at(-1) ?? 0} today`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AsciiArt
      id="garden"
      title="Garden"
      caption={caption}
      draw={(canvas, rand) => drawGarden(canvas, rand, { starts, blooms })}
    />
  );
}

interface Tower {
  readonly key: string;
  readonly title: string;
  readonly total: number;
  readonly working: number;
  readonly waiting: number;
  readonly current: boolean;
  readonly start: (() => void) | null;
}

function drawSkyline(
  canvas: Canvas,
  rand: () => number,
  towers: ReadonlyArray<Tower>,
  night: boolean,
): ArtHit[] {
  const { cols, rows } = canvas;
  const labelled = rows >= 6;
  const ground = rows - (labelled ? 2 : 1);
  const room = ground - 1;
  const max = Math.max(1, ...towers.map((t) => t.total));

  if (night) starfield(canvas, rand, Math.ceil(room * 0.5), 0.03);
  let roof = ground;
  for (let c = 0; c < cols;) {
    const width = 3 + Math.floor(rand() * 6);
    const top = ground - 1 - Math.floor(rand() * Math.max(1, room * 0.55));
    for (let r = Math.min(top, roof) + 1; r <= Math.max(top, roof); r++)
      canvas.set(r, c, "|", "faint");
    canvas.text(top, c + 1, "_".repeat(width), "faint");
    for (let r = top + 1; r < ground; r++)
      for (let k = c + 1; k <= c + width; k++) if (rand() < 0.05) canvas.set(r, k, ".", "faint");
    roof = top;
    c += width + 1;
  }
  for (let c = 0; c < cols; c++) canvas.set(ground, c, "_", "mid");

  const sized = towers.map((tower) => ({
    tower,
    width: Math.min(11, 5 + Math.round(Math.log2(tower.total + 1))) + Math.floor(rand() * 2),
  }));
  const fitting: typeof sized = [];
  let used = 0;
  for (const entry of sized) {
    if (used + entry.width + 1 > cols - 2) break;
    fitting.push(entry);
    used += entry.width + 1;
  }
  const row: typeof sized = [];
  fitting.forEach((entry, i) => (i % 2 === 0 ? row.push(entry) : row.unshift(entry)));

  const hits: ArtHit[] = [];
  let x = Math.floor((cols - used) / 2);
  for (const { tower, width } of row) {
    const scaled = Math.log2(tower.total + 1) / Math.log2(max + 1);
    const height = Math.max(2, Math.min(room, Math.round(2 + scaled * (room - 2))));
    const top = ground - height;
    canvas.clear(top, x, height + 1, width);
    canvas.text(top, x + 1, "_".repeat(width - 2), "mid");
    for (let r = top + 1; r <= ground; r++) {
      canvas.set(r, x, "|", "mid");
      canvas.set(r, x + width - 1, "|", "mid");
    }
    canvas.text(ground, x + 1, "_".repeat(width - 2), "mid");
    const slots: Array<[number, number]> = [];
    for (let r = top + 1; r < ground; r++)
      for (let c = x + 2; c < x + width - 2; c += 2) slots.push([r, c]);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [slots[i], slots[j]] = [slots[j]!, slots[i]!];
    }
    slots.forEach(([r, c], i) => {
      if (i < tower.waiting) canvas.set(r, c, "!", "alert");
      else if (i < tower.waiting + tower.working) canvas.set(r, c, "#", "light");
      else canvas.set(r, c, ".", "faint");
    });
    if (tower.current) canvas.set(top - 1, x + Math.floor(width / 2), "|", "ink");
    if (labelled) {
      const label = truncate(tower.title, width);
      canvas.text(
        rows - 1,
        x + Math.floor((width - label.length) / 2),
        label,
        tower.current ? "strong" : "mid",
      );
    }
    if (tower.start) {
      hits.push({
        key: tower.key,
        row: top,
        col: x,
        width,
        height: rows - top,
        label: `Start a thread in ${tower.title}`,
        onClick: tower.start,
      });
    }
    x += width + 1;
  }
  return hits;
}

export function SkylineBody() {
  const { data } = useWidgetEnv();
  const { preview } = useWidgetFrame();
  const now = useNowMinuteMs();
  const projects = useProjects();
  const startThread = useNewThreadHandler();
  const towers: Tower[] = projects
    .map((project) => {
      const threads = data.threads.filter(
        (t) => t.environmentId === project.environmentId && t.projectId === project.id,
      );
      const current =
        data.project?.environmentId === project.environmentId && data.project.id === project.id;
      return {
        key: `${project.environmentId}:${project.id}`,
        title: project.title,
        total: threads.length,
        working: threads.filter((t) => IN_FLIGHT.has(t.status)).length,
        waiting: threads.filter((t) => NEEDS_YOU.has(t.status)).length,
        current,
        start:
          preview || current
            ? null
            : () => void startThread(scopeProjectRef(project.environmentId, project.id)),
      };
    })
    .sort((a, b) => b.total - a.total);
  if (towers.length === 0) {
    return (
      <WidgetEmpty
        scene="dock"
        title="No projects yet"
        hint="Each project becomes a building here once you add it."
      />
    );
  }
  const working = sum(towers.map((t) => t.working));
  const waiting = sum(towers.map((t) => t.waiting));
  const caption = [
    plural(towers.length, "project"),
    working > 0 ? `${working} windows lit` : "lights out",
    waiting > 0 ? `${waiting} waiting on you` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AsciiArt
      id="skyline"
      title="Skyline"
      caption={caption}
      draw={(canvas, rand) => drawSkyline(canvas, rand, towers, isNight(now))}
    />
  );
}

const RIDGE_DAYS = 30;

function ridgeLevels(counts: ReadonlyArray<number>, cols: number, max: number, height: number) {
  return Array.from({ length: cols + 1 }, (_, c) => {
    const x = (c / cols) * (counts.length - 1);
    const i = Math.floor(x);
    const a = counts[i] ?? 0;
    const b = counts[Math.min(i + 1, counts.length - 1)] ?? a;
    const eased = a + ((b - a) * (1 - Math.cos((x - i) * Math.PI))) / 2;
    return Math.round(Math.sqrt(eased / max) * height);
  });
}

function drawRidgeline(
  canvas: Canvas,
  ridges: { near: ReadonlyArray<number>; far: ReadonlyArray<number>; today: number },
) {
  const { cols, rows } = canvas;
  const base = rows - 1;
  const height = Math.max(1, rows - 4);
  const max = Math.max(1, ...ridges.near, ...ridges.far);
  const far = ridgeLevels(ridges.far, cols, max, height).map((level) => level + 2);
  const near = ridgeLevels(ridges.near, cols, max, height);
  canvas.ridge(base, far, "faint");
  canvas.ridge(base, near, "ink", {
    char: ".",
    tone: "soft",
    density: (depth) => Math.max(0.1, 0.55 - depth * 0.08),
  });

  const peak = ridges.near.indexOf(Math.max(...ridges.near));
  const peakCount = ridges.near[peak] ?? 0;
  if (peakCount === 0) return;
  const day = ridges.today - (ridges.near.length - 1 - peak) * DAY_MS;
  const label = `${weekdayDay.format(day)} · ${peakCount}`;
  const peakCol = Math.round((peak / (ridges.near.length - 1)) * cols);
  const row = Math.max(0, base - (near[peakCol] ?? 0) - 1);
  const col = Math.max(
    1,
    Math.min(cols - label.length - 1, peakCol - Math.floor(label.length / 2)),
  );
  canvas.clear(row, col - 1, 1, label.length + 2);
  canvas.text(row, col, label, "strong");
}

export function RidgelineBody() {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const today = startOfDay(now);
  const both = startsPerDay(data.projectThreads, today, RIDGE_DAYS * 2);
  const far = both.slice(0, RIDGE_DAYS);
  const near = both.slice(RIDGE_DAYS);
  const nearTotal = sum(near);
  const farTotal = sum(far);
  const change = farTotal > 0 ? Math.round(((nearTotal - farTotal) / farTotal) * 100) : null;
  const caption = [
    `${plural(nearTotal, "thread")} in 30 days`,
    change === null ? null : `${change >= 0 ? "+" : "−"}${Math.abs(change)}% on the 30 before`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AsciiArt
      id="ridgeline"
      title="Ridgeline"
      caption={caption}
      draw={(canvas) => drawRidgeline(canvas, { near, far, today })}
    />
  );
}

const BOAT = ["  |\\", "__|_\\_", "\\____/"];

function drawTide(canvas: Canvas, rand: () => number, left: number) {
  const { cols, rows } = canvas;
  const seabed = rows - 1;
  const surface = Math.min(seabed, 1 + Math.round((1 - left / 100) * (seabed - 2)));

  for (let c = 0; c < cols; c++) {
    canvas.set(surface, c, rand() < 0.7 ? "~" : "-", "mid");
    for (let r = surface + 1; r < seabed; r++)
      if (rand() < 0.06 + (r - surface) * 0.04) canvas.set(r, c, ".", "faint");
    canvas.set(seabed, c, rand() < 0.15 ? "," : "_", "faint");
  }
  for (let i = 0; i < Math.max(1, Math.floor(cols / 30)); i++)
    canvas.sprite(seabed - 1, 6 + Math.floor(rand() * (cols - 10)), ["/\\"], "soft");

  if (cols >= 26) {
    const deckFrom = cols - 11;
    canvas.text(0, deckFrom, "=".repeat(11), "mid");
    for (const pile of [deckFrom + 1, deckFrom + 5, deckFrom + 9])
      for (let r = 1; r <= seabed; r++) canvas.set(r, pile, "|", "mid");
  }
  for (let r = 0; r < seabed; r++) {
    canvas.set(r, 1, "|", "soft");
    if (r % 2 === 1) canvas.set(r, 2, "-", "soft");
  }

  const roam = Math.max(1, cols - (cols >= 26 ? 24 : 12));
  const boatCol = 6 + Math.floor(rand() * roam);
  canvas.sprite(surface - 2, boatCol, BOAT, "strong", undefined, true);

  const label = `${left}%`;
  canvas.clear(surface, 3, 1, label.length + 2);
  canvas.text(surface, 4, label, "strong");
}

function formatReset(iso: string | undefined, now: number) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at <= now) return null;
  return at - now < DAY_MS ? resetTime.format(at) : resetDay.format(at);
}

export function TideBody() {
  const now = useNowMinuteMs();
  const windows = useLimitRows().flatMap(({ provider }) =>
    (provider.usageLimits?.windows ?? []).map((window) => ({ provider, window })),
  );
  const tightest = windows.reduce<(typeof windows)[number] | null>(
    (worst, entry) =>
      worst === null || entry.window.usedPercent > worst.window.usedPercent ? entry : worst,
    null,
  );
  if (!tightest) {
    return (
      <WidgetEmpty
        scene="horizon"
        title="No plan limits reported"
        hint="Providers that report session and weekly limits set the tide here."
      />
    );
  }
  const left = Math.max(0, Math.round(100 - tightest.window.usedPercent));
  const reset = formatReset(tightest.window.resetsAt, now);
  const caption = [
    `${tightest.provider.displayName ?? tightest.provider.driver} ${tightest.window.label.toLowerCase()}`,
    `${left}% left`,
    reset ? `resets ${reset}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AsciiArt
      id="tide"
      title="Tide"
      caption={caption}
      draw={(canvas, rand) => drawTide(canvas, rand, left)}
    />
  );
}

const SYNODIC_DAYS = 29.530588853;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

function moonPhase(now: number) {
  const phase = ((((now - KNOWN_NEW_MOON) / DAY_MS / SYNODIC_DAYS) % 1) + 1) % 1;
  const names: Array<[number, string]> = [
    [0.03, "new moon"],
    [0.22, "waxing crescent"],
    [0.28, "first quarter"],
    [0.47, "waxing gibbous"],
    [0.53, "full moon"],
    [0.72, "waning gibbous"],
    [0.78, "last quarter"],
    [0.97, "waning crescent"],
    [1, "new moon"],
  ];
  return { phase, name: names.find(([limit]) => phase < limit)?.[1] ?? "new moon" };
}

const MOON_SMALL = [" .-.", "(   )", " '-'"];
const MOON_LARGE = ["   .---.", " .'     '.", "(         )", " '.     .'", "   '---'"];

function drawMoon(
  canvas: Canvas,
  row: number,
  col: number,
  shape: ReadonlyArray<string>,
  phase: number,
) {
  const full = Math.abs(phase - 0.5) < 0.1;
  canvas.sprite(row, col, shape, full ? "ink" : "soft", undefined, true);
  const terminator = Math.cos(phase * Math.PI * 2);
  shape.forEach((line, r) => {
    const start = line.search(/\S/);
    const end = line.trimEnd().length - 1;
    const center = (start + end) / 2;
    const half = (end - start) / 2;
    for (let c = start + 1; c < end; c++) {
      if (line[c] !== " ") continue;
      const x = (c - center) / half;
      const lit = phase < 0.5 ? x > terminator : x < -terminator;
      if (lit) canvas.set(row + r, col + c, ":", "ink");
    }
  });
}

function drawNightSky(
  canvas: Canvas,
  rand: () => number,
  sky: { stars: ReadonlyArray<ProtoThread>; phase: number },
) {
  const { cols, rows } = canvas;
  const horizon = rows - 1;
  const salt = rand();
  starfield(canvas, rand, horizon - 1, 0.02);

  const shape = rows >= 10 && cols >= 30 ? MOON_LARGE : MOON_SMALL;
  const moonWidth = Math.max(...shape.map((line) => line.length));
  const moonCol = cols - moonWidth - 2 - Math.floor(rand() * cols * 0.15);
  const moonRow = rows >= 10 ? 1 : 0;
  drawMoon(canvas, moonRow, moonCol, shape, sky.phase);
  const inMoon = (r: number, c: number) =>
    r >= moonRow - 1 &&
    r <= moonRow + shape.length &&
    c >= moonCol - 2 &&
    c <= moonCol + moonWidth + 1;

  const clusters = new Map<string, ProtoThread[]>();
  for (const thread of sky.stars) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    clusters.set(key, [...(clusters.get(key) ?? []), thread]);
  }
  const skyRows = Math.max(1, horizon - 2);
  for (const [key, threads] of clusters) {
    const place = seededRandom(`${salt}:${key}`);
    const spread = Math.min(cols * 0.5, 10 + threads.length * 4);
    const left = place() * Math.max(1, cols - spread);
    const taken = new Set<string>();
    const points = threads
      .map((thread) => {
        const jitter = seededRandom(`${salt}:${thread.key}`);
        let col = Math.round(left + jitter() * spread);
        const row = Math.round(jitter() * skyRows);
        if (inMoon(row, col)) col = moonCol - 3 - Math.floor(jitter() * 8);
        while (taken.has(`${row}:${col}`)) col += 2;
        taken.add(`${row}:${col}`);
        return { thread, row, col: Math.max(0, Math.min(cols - 1, col)) };
      })
      .sort((a, b) => a.col - b.col);
    points.slice(1).forEach((point, i) => {
      const from = points[i]!;
      const steps = Math.max(Math.abs(point.col - from.col), Math.abs(point.row - from.row));
      for (let s = 1; s < steps; s++) {
        const r = Math.round(from.row + ((point.row - from.row) * s) / steps);
        const c = Math.round(from.col + ((point.col - from.col) * s) / steps);
        if (s % 2 === 0 && !inMoon(r, c)) canvas.set(r, c, ".", "soft");
      }
    });
    for (const point of points) {
      const unread = point.thread.unread;
      canvas.set(point.row, point.col, unread ? "*" : "+", unread ? "light" : "ink");
    }
  }
  hills(canvas, rand, 1);
}

export function NightSkyBody() {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const today = startOfDay(now);
  const stars = data.threads.filter(
    (t) => t.status !== "failed" && t.finishedAt !== null && Date.parse(t.finishedAt) >= today,
  );
  const unread = stars.filter((t) => t.unread).length;
  const moon = moonPhase(now);
  const caption = [
    stars.length > 0 ? `${plural(stars.length, "turn")} finished today` : "No turns finished yet",
    unread > 0 ? `${unread} unread` : null,
    moon.name,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AsciiArt
      id="night-sky"
      title="Night sky"
      caption={caption}
      draw={(canvas, rand) => drawNightSky(canvas, rand, { stars, phase: moon.phase })}
    />
  );
}
