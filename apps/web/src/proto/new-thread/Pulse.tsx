import { useMemo, type ReactNode } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { type ProtoData, type ProtoThread } from "./data";

const DAY_MS = 86_400_000;
const LEVELS = [
  "bg-foreground/[0.06]",
  "bg-foreground/20",
  "bg-foreground/40",
  "bg-foreground/65",
  "bg-foreground/90",
];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });

export function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hourLabel(hour: number) {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

export type PulseStats = ReturnType<typeof pulseStats>;

function pulseStats(threads: ReadonlyArray<ProtoThread>, today: number, weekCount: number) {
  const mondayOffset = (new Date(today).getDay() + 6) % 7;
  const gridStart = today - (mondayOffset + (weekCount - 1) * 7) * DAY_MS;
  const perDay = new Map<number, number>();
  const perHour = Array<number>(24).fill(0);
  const perWeekday = Array<number>(7).fill(0);
  for (const thread of threads) {
    const created = Date.parse(thread.createdAt);
    if (Number.isNaN(created) || created < gridStart) continue;
    const day = startOfDay(created);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    perHour[new Date(created).getHours()]! += 1;
    perWeekday[(new Date(created).getDay() + 6) % 7]! += 1;
  }
  const max = Math.max(1, ...perDay.values());
  const level = (count: number) => (count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)));
  const weeks = Array.from({ length: weekCount }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const day = gridStart + (w * 7 + d) * DAY_MS;
      const count = perDay.get(startOfDay(day + DAY_MS / 2)) ?? 0;
      return { day, count, level: level(count), future: day > today };
    }),
  );
  const thisWeekStart = today - mondayOffset * DAY_MS;
  const sumBetween = (from: number, to: number) =>
    [...perDay].reduce((sum, [day, count]) => (day >= from && day < to ? sum + count : sum), 0);
  const thisWeek = sumBetween(thisWeekStart, today + DAY_MS);
  const lastWeek = sumBetween(thisWeekStart - 7 * DAY_MS, thisWeekStart);
  const previousDay = (day: number) => startOfDay(day - DAY_MS / 2);
  let streak = 0;
  let cursor = perDay.has(today) ? today : previousDay(today);
  while (perDay.has(cursor)) {
    streak += 1;
    cursor = previousDay(cursor);
  }
  const total = [...perDay.values()].reduce((a, b) => a + b, 0);
  const busiestDay = perWeekday.indexOf(Math.max(...perWeekday));
  const peakHour = perHour.indexOf(Math.max(...perHour));
  const merged = new Set(
    threads.flatMap((t) => t.prs.filter((pr) => pr.state === "merged").map((pr) => pr.key)),
  ).size;
  return { today, weeks, perHour, thisWeek, lastWeek, streak, total, busiestDay, peakHour, merged };
}

export function usePulseStats(threads: ReadonlyArray<ProtoThread>, weekCount: number) {
  const now = useNowMinuteMs();
  const today = startOfDay(now);
  return useMemo(() => pulseStats(threads, today, weekCount), [threads, today, weekCount]);
}

export function Heatmap({ stats, labels = true }: { stats: PulseStats; labels?: boolean }) {
  return (
    <figure
      className="flex shrink-0 flex-col gap-1.5"
      aria-label={`${stats.total} threads started in the last ${stats.weeks.length} weeks`}
    >
      {labels ? (
        <div className="flex gap-0.75 pl-8 text-3xs text-secondary-label">
          {stats.weeks.map((week, w) => {
            const first = week[0]!.day;
            const showMonth =
              w === 0 ||
              new Date(first).getMonth() !== new Date(stats.weeks[w - 1]![0]!.day).getMonth();
            return (
              <span key={first} className="w-3 shrink-0 overflow-visible whitespace-nowrap">
                {showMonth ? monthFormat.format(first) : ""}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="flex gap-0.75">
        {labels ? (
          <div className="flex w-8 shrink-0 flex-col gap-0.75 text-3xs leading-3 text-secondary-label">
            {WEEKDAYS.map((d, i) => (
              <span key={d} className="h-3">
                {i % 2 === 0 ? d : ""}
              </span>
            ))}
          </div>
        ) : null}
        {stats.weeks.map((week) => (
          <div key={week[0]!.day} className="flex flex-col gap-0.75">
            {week.map((cell) => (
              <span
                key={cell.day}
                className={cn(
                  "size-3 rounded-xs",
                  cell.future ? "bg-transparent" : LEVELS[cell.level],
                  cell.day === stats.today &&
                    "ring-1 ring-foreground/50 ring-offset-1 ring-offset-background",
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </figure>
  );
}

export function HourBars({ stats, className }: { stats: PulseStats; className?: string }) {
  const now = useNowMinuteMs();
  const hourMax = Math.max(1, ...stats.perHour);
  const currentHour = new Date(now).getHours();
  return (
    <figure
      className={cn("flex min-w-0 flex-1 flex-col justify-end gap-1.5", className)}
      aria-label={`Most threads start around ${hourLabel(stats.peakHour)}`}
    >
      <figcaption className="flex justify-between text-xs text-secondary-label">
        <span>When your agents start</span>
        <span>Peak {stats.total > 0 ? hourLabel(stats.peakHour) : "—"}</span>
      </figcaption>
      <div className="flex h-16 items-end gap-px">
        {HOURS.map((hour) => (
          <span
            key={hour}
            className={cn(
              "flex-1 rounded-t-xs",
              hour === currentHour ? "bg-foreground/70" : "bg-foreground/20",
            )}
            style={{ height: `${Math.max(6, ((stats.perHour[hour] ?? 0) / hourMax) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-3xs tabular-nums text-secondary-label">
        {[0, 6, 12, 18, 23].map((h) => (
          <span key={h}>{hourLabel(h)}</span>
        ))}
      </div>
    </figure>
  );
}

export function Stat(props: {
  label: string;
  value: number | string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-secondary-label">{props.label}</dt>
      <dd className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-semibold tabular-nums tracking-tight text-foreground",
            props.compact ? "text-base" : "text-xl",
          )}
        >
          {props.value}
        </span>
        {props.children}
      </dd>
    </div>
  );
}

export function WeekDelta({ stats }: { stats: PulseStats }) {
  if (stats.lastWeek === 0 && stats.thisWeek === 0) return null;
  const delta = stats.thisWeek - stats.lastWeek;
  return (
    <span
      className={cn("text-xs tabular-nums", delta >= 0 ? "text-success" : "text-muted-foreground")}
    >
      {delta >= 0 ? "+" : "−"}
      {Math.abs(delta)} vs last
    </span>
  );
}

export function Pulse({ data }: { data: ProtoData }) {
  const stats = usePulseStats(data.projectThreads, 16);
  const projectName = data.project?.title ?? "All projects";

  return (
    <div className="chat-composer-lane flex min-h-full flex-col justify-end">
      <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-5 pb-3">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <h2 className="text-sm font-medium text-foreground">{projectName}, lately</h2>
          <span className="text-xs text-secondary-label">Threads started · 16 weeks</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-1 sm:grid-cols-4">
          <Stat label="This week" value={stats.thisWeek}>
            <WeekDelta stats={stats} />
          </Stat>
          <Stat label="Day streak" value={stats.streak} />
          <Stat label="Busiest day" value={stats.total > 0 ? WEEKDAYS[stats.busiestDay]! : "—"} />
          <Stat label="PRs merged" value={stats.merged} />
        </dl>
        <div className="flex flex-col gap-6 px-1 sm:flex-row sm:items-end">
          <Heatmap stats={stats} />
          <HourBars stats={stats} />
        </div>
      </div>
    </div>
  );
}
