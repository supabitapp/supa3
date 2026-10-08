import { ClockIcon, ListChecksIcon } from "lucide-react";

import { PULL_REQUEST_STATE_PRESENTATION } from "../../../components/pullRequest/pullRequestIcons";
import { Button } from "../../../components/ui/button";
import { useNowMinuteMs } from "../../../hooks/useNowMinute";
import { cn } from "../../../lib/utils";
import { ago, shortRepo, until, useOpenThread, type ProtoPr, type ProtoThread } from "../data";
import { More, Row, Time } from "./bodies";
import { rowsThatFit, useWidgetEnv, useWidgetFrame } from "./context";
import { WidgetEmpty } from "./scenes";

const DAY_MS = 86_400_000;
const QUIET_DAYS = 3;

function ProjectTag({ thread }: { thread: ProtoThread }) {
  const { size } = useWidgetFrame();
  if (size === "s") return null;
  return (
    <span className="max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground">
      {thread.projectName}
    </span>
  );
}

export function PlansBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const plans = data.threads.filter((t) => t.planReady);
  if (plans.length === 0) {
    return (
      <WidgetEmpty
        scene="chart"
        title="No plans to review"
        hint="When an agent in plan mode proposes a plan, it waits here for your go-ahead."
      />
    );
  }
  const shown = plans.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-info" />
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          <ProjectTag thread={t} />
          <Time>{ago(t.updatedAt, now)}</Time>
        </Row>
      ))}
      <More n={plans.length - shown.length} label="plans" />
    </div>
  );
}

export function QuietBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const quiet = data.threads
    .filter(
      (t) =>
        t.status === "ready" &&
        t.pinnedAt === null &&
        (t.snoozedUntil === null || Date.parse(t.snoozedUntil) <= now) &&
        now - Date.parse(t.updatedAt) >= QUIET_DAYS * DAY_MS &&
        (t.worktreePath !== null || t.prs.some((pr) => pr.state === "open")),
    )
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  if (quiet.length === 0) {
    return (
      <WidgetEmpty
        scene="bottle"
        title="Nothing gone quiet"
        hint={`Threads with an open pull request or worktree that sit for ${QUIET_DAYS} days wash up here.`}
      />
    );
  }
  const shown = quiet.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => {
        const pr = t.prs.find((p) => p.state === "open");
        return (
          <Row key={t.key} onClick={() => openThread(t)}>
            <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
            {pr ? (
              <span
                className={cn(
                  "shrink-0 text-xs",
                  PULL_REQUEST_STATE_PRESENTATION[pr.isDraft ? "draft" : "open"].toneClassName,
                )}
              >
                #{pr.number}
              </span>
            ) : (
              <ProjectTag thread={t} />
            )}
            <Time>{ago(t.updatedAt, now)}</Time>
          </Row>
        );
      })}
      <More n={quiet.length - shown.length} label="quiet" />
    </div>
  );
}

export function PausedBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const paused = data.threads
    .filter((t) => t.status === "limited")
    .sort(
      (a, b) => Date.parse(a.resumesAt ?? "9999-12-31") - Date.parse(b.resumesAt ?? "9999-12-31"),
    );
  if (paused.length === 0) {
    return (
      <WidgetEmpty
        scene="anchor"
        title="Nothing paused"
        hint="Threads that hit a usage limit wait here, with when they pick back up."
      />
    );
  }
  const shown = paused.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <ClockIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-secondary-label">
            {t.resumesAt ? `resumes in ${until(t.resumesAt, now)}` : "paused"}
          </span>
        </Row>
      ))}
      <More n={paused.length - shown.length} label="paused" />
    </div>
  );
}

export function CatchUpBody() {
  const { data } = useWidgetEnv();
  const { size, preview } = useWidgetFrame();
  const openThread = useOpenThread();
  const unread = data.threads
    .filter((t) => t.status === "ready" && t.unread)
    .sort(
      (a, b) => Date.parse(a.finishedAt ?? a.updatedAt) - Date.parse(b.finishedAt ?? b.updatedAt),
    );
  const next = unread[0];
  if (!next) {
    return (
      <WidgetEmpty
        scene="moored"
        title="All caught up"
        hint="Finished threads you haven't opened line up here, oldest first."
      />
    );
  }
  const upcoming = unread.slice(0, size === "s" ? 1 : 3);
  return (
    <div className="flex h-full flex-col justify-between gap-2 px-3 pb-3">
      <p className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {unread.length}
        </span>
        <span className="text-xs text-muted-foreground">finished, not opened yet</span>
      </p>
      <ol className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
        {upcoming.map((t, i) => (
          <li key={t.key} className="flex min-w-0 gap-1.5">
            <span className="shrink-0 tabular-nums text-secondary-label">{i + 1}</span>
            <span className={cn("truncate", i === 0 && "text-foreground")}>{t.title}</span>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        variant="outline"
        tabIndex={preview ? -1 : undefined}
        onClick={() => openThread(next)}
      >
        Open the oldest
      </Button>
    </div>
  );
}

function mergedThisWeek(threads: ReadonlyArray<ProtoThread>, now: number): ProtoPr[] {
  const seen = new Map<string, ProtoPr>();
  for (const thread of threads)
    for (const pr of thread.prs) {
      const at = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
      if (pr.state === "merged" && now - at <= 7 * DAY_MS && !seen.has(pr.key))
        seen.set(pr.key, pr);
    }
  return [...seen.values()].sort(
    (a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""),
  );
}

export function ShippedBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const merged = mergedThisWeek(data.threads, now);
  const MergedIcon = PULL_REQUEST_STATE_PRESENTATION.merged.Icon;
  if (merged.length === 0) {
    return (
      <WidgetEmpty
        scene="rafted"
        title="Nothing merged this week"
        hint="Pull requests your threads merged in the last 7 days land here."
      />
    );
  }
  const shown = merged.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((pr) => (
        <Row key={pr.key} href={pr.url}>
          <MergedIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
            )}
          />
          <span className="min-w-0 flex-1 truncate text-foreground">{pr.title}</span>
          {size === "s" ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {shortRepo(pr.repository)}#{pr.number}
            </span>
          )}
          <Time>{ago(pr.updatedAt, now)}</Time>
        </Row>
      ))}
      <More n={merged.length - shown.length} label="merged" />
    </div>
  );
}
