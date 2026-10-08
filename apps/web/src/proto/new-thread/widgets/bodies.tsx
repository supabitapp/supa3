import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useNowMinuteMs } from "../../../hooks/useNowMinute";
import { resolveDiscoveredServerUrl } from "../../../browser/browserTargetResolver";
import type { ComposerHandleRef } from "../../../composerHandleContext";
import { PullRequestGlyph } from "../../../components/pullRequest/pullRequestIcons";
import { cn } from "../../../lib/utils";
import { useDiscoveredPortsState } from "../../../portDiscoveryState";
import { IN_FLIGHT, NEEDS_YOU, ago, shortRepo, uniqueOpenPrs, useOpenThread } from "../data";
import { ChecksIcon, STATUS_TONE } from "../Desk";
import { HarborScene, harborCaption } from "../Harbor";
import { buildStarters } from "../Launchpad";
import { Heatmap, HourBars, Stat, WEEKDAYS, WeekDelta, usePulseStats } from "../Pulse";
import { rowsThatFit, useWidgetEnv, useWidgetFrame } from "./context";
import { WidgetEmpty } from "./scenes";

export function writeToComposer(composerRef: ComposerHandleRef, text: string) {
  const composer = composerRef.current;
  if (!composer) return;
  composer.insertTextAtEnd(text, { ensureLeadingBoundary: true });
  composer.focusAtEnd();
}

const ROW_CLASS =
  "flex h-8 w-full min-w-0 shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80";

export function Row(props: {
  onClick?: (() => void) | undefined;
  href?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  const { preview } = useWidgetFrame();
  if (props.href) {
    return (
      <a
        href={props.href}
        target="_blank"
        rel="noreferrer"
        tabIndex={preview ? -1 : undefined}
        className={cn(ROW_CLASS, props.className)}
      >
        {props.children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      tabIndex={preview ? -1 : undefined}
      className={cn(ROW_CLASS, props.className)}
    >
      {props.children}
    </button>
  );
}

export function More({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null;
  return (
    <p className="px-2 pt-0.5 text-xs text-secondary-label">
      +{n} more {label}
    </p>
  );
}

export function Time({ children }: { children: ReactNode }) {
  return (
    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-secondary-label">
      {children}
    </span>
  );
}

export function NeedsYouBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const rows = data.threads.filter((t) => NEEDS_YOU.has(t.status));
  if (rows.length === 0) {
    return (
      <WidgetEmpty
        scene="calm"
        title="Nothing needs you"
        hint="Agents asking for approval or an answer show up here first."
      />
    );
  }
  const shown = rows.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <span className={cn("shrink-0 text-xs font-medium", STATUS_TONE[t.status].className)}>
            {STATUS_TONE[t.status].label}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          {size === "s" ? null : (
            <span className="max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground">
              {t.projectName}
            </span>
          )}
          <Time>{ago(t.updatedAt, now)}</Time>
        </Row>
      ))}
      <More n={rows.length - shown.length} label="waiting" />
    </div>
  );
}

export function WorkingBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const rows = data.threads.filter((t) => IN_FLIGHT.has(t.status));
  if (rows.length === 0) {
    return (
      <WidgetEmpty
        scene="moored"
        title="No agents working"
        hint="Describe a task below and an agent starts on it."
      />
    );
  }
  const shown = rows.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          {size === "s" ? null : (
            <span className="max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground">
              {t.projectName}
            </span>
          )}
          <Time>{ago(t.activeSince, now)}</Time>
        </Row>
      ))}
      <More n={rows.length - shown.length} label="working" />
    </div>
  );
}

export function FinishedBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const rows = data.threads
    .filter((t) => t.status === "ready" && t.finishedAt !== null)
    .sort(
      (a, b) =>
        Number(b.unread) - Number(a.unread) ||
        Date.parse(b.finishedAt ?? "") - Date.parse(a.finishedAt ?? ""),
    );
  if (rows.length === 0) {
    return (
      <WidgetEmpty
        scene="horizon"
        title="Nothing finished lately"
        hint="Turns that just ended land here."
      />
    );
  }
  const shown = rows.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          {size === "s" ? null : (
            <span className="max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground">
              {t.projectName}
            </span>
          )}
          {t.unread ? (
            <>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
              <span className="sr-only">Unread</span>
            </>
          ) : null}
          <Time>{ago(t.finishedAt, now)}</Time>
        </Row>
      ))}
      <More n={rows.length - shown.length} label="finished" />
    </div>
  );
}

export function PullRequestsBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const prs = uniqueOpenPrs(data.threads);
  if (prs.length === 0) {
    return (
      <WidgetEmpty
        scene="dock"
        title="No open pull requests"
        hint="Pull requests your agents open show up here with their checks."
      />
    );
  }
  const shown = prs.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((pr) => {
        const Icon = pr.isDraft ? PullRequestGlyph.draft : PullRequestGlyph.pullRequest;
        return (
          <Row key={pr.key} href={pr.url}>
            <Icon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0",
                pr.isDraft ? "text-muted-foreground" : "text-success",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{pr.title}</span>
            {pr.conflicting ? <span className="shrink-0 text-xs text-error">Conflicts</span> : null}
            <ChecksIcon checks={pr.checks} />
            {size === "s" ? null : (
              <span className="shrink-0 font-mono text-xs text-secondary-label">
                {shortRepo(pr.repository)}#{pr.number}
              </span>
            )}
          </Row>
        );
      })}
      <More n={prs.length - shown.length} label="open" />
    </div>
  );
}

export function ServicesBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const threadById = new Map(data.threads.map((t) => [t.id, t]));
  const environmentId = data.project?.environmentId ?? null;
  const services = [...useDiscoveredPortsState(environmentId).servers].sort(
    (a, b) => Number(Boolean(b.terminal)) - Number(Boolean(a.terminal)) || a.port - b.port,
  );
  if (services.length === 0) {
    return (
      <WidgetEmpty
        scene="dock"
        title="Nothing is listening"
        hint="Dev servers your agents start show up here."
      />
    );
  }
  const shown = services.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((server) => {
        const owner = server.terminal ? threadById.get(server.terminal.threadId) : undefined;
        return (
          <Row
            key={server.url}
            href={
              environmentId ? resolveDiscoveredServerUrl(environmentId, server.url) : server.url
            }
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
            <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-foreground">
              :{server.port}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {owner?.title ?? server.processName ?? server.host}
            </span>
          </Row>
        );
      })}
      <More n={services.length - shown.length} label="listening" />
    </div>
  );
}

export function StartersBody() {
  const { data, composerRef } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const now = useNowMinuteMs();
  const starters = buildStarters(data, now, Math.max(1, Math.floor((bodyHeight - 4) / 48)));
  if (starters.length === 0) {
    return (
      <WidgetEmpty
        scene="chart"
        title="Nothing to pick up"
        hint="Conflicts, failing checks and unfinished work show up here."
      />
    );
  }
  const apply = (prompt: string) => writeToComposer(composerRef, prompt);
  return (
    <div className="flex flex-col">
      {starters.map((starter) => {
        const Icon = starter.icon;
        return (
          <Row
            key={starter.key}
            onClick={() => apply(starter.prompt)}
            className="h-12 flex-col items-start justify-center gap-0.5"
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Icon aria-hidden className={cn("size-3.5 shrink-0", starter.tone)} />
              <span className="truncate">{starter.reason}</span>
            </span>
            <span className="w-full truncate text-foreground">{starter.prompt}</span>
          </Row>
        );
      })}
    </div>
  );
}

export function HarborBody() {
  const { data } = useWidgetEnv();
  return (
    <div className="relative size-full">
      <HarborScene data={data} sizing="box" className="size-full overflow-hidden px-2" />
      <p className="pointer-events-none absolute top-2 left-3 rounded-md bg-background/80 px-2 py-0.5 text-xs text-muted-foreground backdrop-blur-sm">
        {harborCaption(data)}
      </p>
    </div>
  );
}

export function ActivityBody() {
  const { data } = useWidgetEnv();
  const { size } = useWidgetFrame();
  const stats = usePulseStats(data.projectThreads, 16);
  const showHours = size === "l" || size === "w";
  return (
    <div
      className={cn(
        "flex h-full gap-5 px-2 pt-1",
        size === "l" ? "flex-col" : "flex-row items-end",
      )}
    >
      <div className="flex items-end gap-5">
        <Heatmap stats={stats} />
        <dl className="flex flex-col gap-2">
          <Stat compact label="This week" value={stats.thisWeek}>
            <WeekDelta stats={stats} />
          </Stat>
          <Stat compact label="Day streak" value={stats.streak} />
          {size === "m" ? null : (
            <Stat
              compact
              label="Busiest day"
              value={stats.total > 0 ? WEEKDAYS[stats.busiestDay]! : "—"}
            />
          )}
        </dl>
      </div>
      {showHours ? <HourBars stats={stats} /> : null}
    </div>
  );
}
