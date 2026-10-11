import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../../components/ui/button";
import { LimitWindows } from "../../../components/usage/UsageLimits";
import { useNowMinuteMs } from "../../../hooks/useNowMinute";
import { cn } from "../../../lib/utils";
import { DAY_MS, ago, countPerDay } from "../data";
import { startOfDay } from "../Pulse";
import { useLimitRows } from "../widgets/appWidgets";
import { PrRow, ThreadRow, writeToComposer } from "../widgets/bodies";
import { ROW_PX, useWidgetEnv, useWidgetFrame } from "../widgets/context";
import { countQuery, groupQuery, selectPullRequests, selectThreads } from "./query";
import type { TileElement, TileProps, TileSpec, TileTone } from "./spec";

const TONE: Record<TileTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning-foreground",
  danger: "text-error",
  info: "text-info",
};

const BADGE_TONE: Record<TileTone, string> = {
  default: "bg-muted text-foreground",
  muted: "bg-muted text-muted-foreground",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning-foreground",
  danger: "bg-error/12 text-error",
  info: "bg-info/12 text-info",
};

const TEXT_SIZE = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg font-semibold tracking-tight",
};

const GAP = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" };
const ALIGN = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};
const GRID_COLUMNS = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };
const WIDE: ReadonlySet<TileElement["type"]> = new Set([
  "ThreadList",
  "PullRequestList",
  "BarList",
  "Sparkline",
]);

function useFitRows(limit: number | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(3);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setFit(Math.max(1, Math.floor(element.clientHeight / ROW_PX)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, Math.min(fit, Math.max(1, Math.round(limit ?? 20)))] as const;
}

function Label({ children }: { children: ReactNode }) {
  return <span className="truncate text-xs text-muted-foreground">{children}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-secondary-label">{children}</p>;
}

function Stack({ props, children }: { props: TileProps<"Stack">; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        props.direction === "row" ? "flex-row" : "flex-col",
        GAP[props.gap ?? "md"],
        props.align ? ALIGN[props.align] : undefined,
      )}
    >
      {children}
    </div>
  );
}

function Metric({ props }: { props: TileProps<"Metric"> }) {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const n = countQuery(data, props, now);
  const warn = props.warnAbove !== undefined && n > props.warnAbove;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Label>{props.label}</Label>
      <span
        className={cn(
          "text-2xl font-semibold tabular-nums tracking-tight",
          warn ? "text-warning-foreground" : "text-foreground",
        )}
      >
        {n}
      </span>
    </div>
  );
}

function Ratio({ props }: { props: TileProps<"Ratio"> }) {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const part = countQuery(data, props.part, now);
  const whole = countQuery(data, props.whole, now);
  const share = whole > 0 ? Math.min(1, part / whole) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label>{props.label}</Label>
        <span className="shrink-0 text-xs tabular-nums text-foreground">
          {part} of {whole}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
        <div
          className="h-full rounded-full bg-foreground/60"
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

function Sparkline({ props }: { props: TileProps<"Sparkline"> }) {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const days = props.days ?? 14;
  const today = startOfDay(now);
  const field = props.field ?? "createdAt";
  const counts = countPerDay(
    selectThreads(data, props.where, now).map((t) => t[field]),
    today,
    days,
  );
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between gap-2">
        <Label>{props.label ?? `Last ${days} days`}</Label>
        <span className="shrink-0 text-xs tabular-nums text-foreground">{total}</span>
      </figcaption>
      <div className="flex min-h-8 flex-1 items-end gap-px">
        {counts.map((count, i) => (
          <span
            key={today - (days - 1 - i) * DAY_MS}
            className={cn(
              "flex-1 rounded-t-xs",
              i === days - 1 ? "bg-foreground/70" : "bg-foreground/20",
            )}
            style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
          />
        ))}
      </div>
    </figure>
  );
}

function BarList({ props }: { props: TileProps<"BarList"> }) {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const [ref, fit] = useFitRows(props.limit);
  const groups = groupQuery(data, props, now);
  const max = Math.max(1, ...groups.map((g) => g.count));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      {props.label ? <Label>{props.label}</Label> : null}
      <div ref={ref} className="flex min-h-0 flex-1 flex-col">
        {groups.length === 0 ? <Empty>Nothing to count yet.</Empty> : null}
        {groups.slice(0, fit).map((group) => (
          <div key={group.label} className="flex h-8 shrink-0 items-center gap-2 text-sm">
            <span className="w-2/5 min-w-0 truncate text-foreground">{group.label}</span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
              <span
                className="h-full rounded-full bg-foreground/45"
                style={{ width: `${(group.count / max) * 100}%` }}
              />
            </span>
            <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {group.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThreadList({ props }: { props: TileProps<"ThreadList"> }) {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const [ref, fit] = useFitRows(props.limit);
  const key = props.sort === "created" ? "createdAt" : "updatedAt";
  const direction = props.sort === "oldest" ? 1 : -1;
  const threads = selectThreads(data, props.where, now).sort(
    (a, b) => direction * (Date.parse(a[key]) - Date.parse(b[key])),
  );
  return (
    <div ref={ref} className="@container -mx-2 flex min-h-0 min-w-0 flex-1 flex-col">
      {threads.length === 0 ? <Empty>{props.empty ?? "No threads match."}</Empty> : null}
      {threads.slice(0, fit).map((t) => (
        <ThreadRow key={t.key} thread={t} time={ago(t.updatedAt, now)} />
      ))}
    </div>
  );
}

function PullRequestList({ props }: { props: TileProps<"PullRequestList"> }) {
  const { data } = useWidgetEnv();
  const now = useNowMinuteMs();
  const [ref, fit] = useFitRows(props.limit);
  const direction = props.sort === "oldest" ? 1 : -1;
  const prs = selectPullRequests(data, props.where, now).sort(
    (a, b) => direction * (Date.parse(a.updatedAt ?? "") - Date.parse(b.updatedAt ?? "")),
  );
  return (
    <div ref={ref} className="@container -mx-2 flex min-h-0 min-w-0 flex-1 flex-col">
      {prs.length === 0 ? <Empty>{props.empty ?? "No pull requests match."}</Empty> : null}
      {prs.slice(0, fit).map((pr) => (
        <PrRow key={pr.key} pr={pr} time={ago(pr.updatedAt, now)} />
      ))}
    </div>
  );
}

function UsageGauge({ props }: { props: TileProps<"UsageGauge"> }) {
  const now = useNowMinuteMs();
  const needle = props.provider?.toLowerCase();
  const rows = useLimitRows().filter(
    ({ provider }) =>
      !needle || `${provider.displayName ?? ""} ${provider.driver}`.toLowerCase().includes(needle),
  );
  if (rows.length === 0) return <Empty>No plan limits reported.</Empty>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {rows.map(({ key, provider }) => (
        <div key={key} className="flex flex-col gap-1">
          <Label>{provider.displayName ?? provider.driver}</Label>
          <LimitWindows
            driver={provider.driver}
            windows={provider.usageLimits?.windows ?? []}
            now={now}
            compact
          />
        </div>
      ))}
    </div>
  );
}

function PromptButton({ props }: { props: TileProps<"PromptButton"> }) {
  const { composerRef } = useWidgetEnv();
  const { preview } = useWidgetFrame();
  return (
    <Button
      size="sm"
      variant="outline"
      tabIndex={preview ? -1 : undefined}
      onClick={() => writeToComposer(composerRef, props.prompt)}
    >
      {props.label}
    </Button>
  );
}

function TextLine({ props }: { props: TileProps<"Text"> }) {
  return (
    <p className={cn("text-pretty", TEXT_SIZE[props.size ?? "sm"], TONE[props.tone ?? "default"])}>
      {props.text}
    </p>
  );
}

function ElementView({ element, children }: { element: TileElement; children: ReactNode }) {
  switch (element.type) {
    case "Stack":
      return <Stack props={element.props}>{children}</Stack>;
    case "Grid":
      return (
        <div className={cn("grid min-w-0 gap-3", GRID_COLUMNS[element.props.columns ?? 2])}>
          {children}
        </div>
      );
    case "Section":
      return (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-xs font-medium text-muted-foreground">
              {element.props.title}
            </h3>
            {element.props.hint ? (
              <span className="truncate text-xs text-secondary-label">{element.props.hint}</span>
            ) : null}
          </div>
          {children}
        </section>
      );
    case "Divider":
      return <hr className="border-border/60" />;
    case "Text":
      return <TextLine props={element.props} />;
    case "Badge":
      return (
        <span
          className={cn(
            "w-fit rounded-sm px-1.5 py-0.5 text-2xs font-medium",
            BADGE_TONE[element.props.tone ?? "default"],
          )}
        >
          {element.props.text}
        </span>
      );
    case "Metric":
      return <Metric props={element.props} />;
    case "Ratio":
      return <Ratio props={element.props} />;
    case "Sparkline":
      return <Sparkline props={element.props} />;
    case "BarList":
      return <BarList props={element.props} />;
    case "ThreadList":
      return <ThreadList props={element.props} />;
    case "PullRequestList":
      return <PullRequestList props={element.props} />;
    case "UsageGauge":
      return <UsageGauge props={element.props} />;
    case "PromptButton":
      return <PromptButton props={element.props} />;
    case "Link":
      return element.props.href.startsWith("https://") ? (
        <a
          href={element.props.href}
          target="_blank"
          rel="noreferrer"
          className="w-fit text-sm text-info underline-offset-2 hover:underline"
        >
          {element.props.label}
        </a>
      ) : (
        <TextLine props={{ text: element.props.label }} />
      );
  }
}

function isWide(spec: TileSpec, id: string): boolean {
  const element = spec.elements.get(id);
  return (
    element !== undefined &&
    (WIDE.has(element.type) || element.children.some((child) => isWide(spec, child)))
  );
}

function TileNode({ spec, id }: { spec: TileSpec; id: string }) {
  const element = spec.elements.get(id);
  if (!element) return null;
  const row = element.type === "Stack" && element.props.direction === "row";
  return (
    <ElementView element={element}>
      {element.children.map((childId) =>
        row ? (
          <div
            key={childId}
            className={cn(
              "flex min-h-0 min-w-0 flex-col",
              isWide(spec, childId) ? "flex-3" : "flex-1",
            )}
          >
            <TileNode spec={spec} id={childId} />
          </div>
        ) : (
          <TileNode key={childId} spec={spec} id={childId} />
        ),
      )}
    </ElementView>
  );
}

export function TileRenderer({ spec }: { spec: TileSpec }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-3 pb-3">
      <TileNode spec={spec} id={spec.root} />
    </div>
  );
}
