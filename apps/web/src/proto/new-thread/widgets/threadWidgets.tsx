import {
  BotIcon,
  GitBranchIcon,
  MoonIcon,
  PinIcon,
  SquareTerminalIcon,
  TelescopeIcon,
} from "lucide-react";
import { scopeProjectRef } from "@supacode/client-runtime/environment";
import { useState } from "react";

import { useNowMinuteMs } from "../../../hooks/useNowMinute";
import { ProjectFavicon } from "../../../components/ProjectFavicon";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../../components/pullRequest/pullRequestIcons";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useProjects } from "../../../state/entities";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { IN_FLIGHT, NEEDS_YOU, ago, until, useOpenThread, type ProtoThread } from "../data";
import { STATUS_TONE } from "../Desk";
import { startOfDay } from "../Pulse";
import { More, Row, Time, writeToComposer } from "./bodies";
import { rowsThatFit, useWidgetEnv, useWidgetFrame } from "./context";
import { WidgetEmpty } from "./scenes";

const DAY_MS = 86_400_000;

function StatusDot({ thread }: { thread: ProtoThread }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        STATUS_TONE[thread.status].className,
      )}
    />
  );
}

export function PinnedBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const pinned = data.threads
    .filter((t) => t.pinnedAt !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (pinned.length === 0) {
    return (
      <WidgetEmpty
        scene="moored"
        title="Nothing pinned"
        hint="Pin a thread in the sidebar to keep it one click away."
      />
    );
  }
  const shown = pinned.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <PinIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          {size === "s" ? null : <StatusDot thread={t} />}
          <Time>{ago(t.updatedAt, now)}</Time>
        </Row>
      ))}
      <More n={pinned.length - shown.length} label="pinned" />
    </div>
  );
}

export function SnoozedBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const snoozed = data.threads
    .filter((t) => t.snoozedUntil !== null && Date.parse(t.snoozedUntil) > now)
    .sort((a, b) => Date.parse(a.snoozedUntil ?? "") - Date.parse(b.snoozedUntil ?? ""));
  if (snoozed.length === 0) {
    return (
      <WidgetEmpty
        scene="anchor"
        title="Nothing snoozed"
        hint="Snoozed threads wait here and come back on their own."
      />
    );
  }
  const shown = snoozed.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((t) => (
        <Row key={t.key} onClick={() => openThread(t)}>
          <MoonIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-secondary-label">
            in {until(t.snoozedUntil, now)}
          </span>
        </Row>
      ))}
      <More n={snoozed.length - shown.length} label="snoozed" />
    </div>
  );
}

const GOAL_TONE: Record<string, string> = {
  active: "text-info",
  paused: "text-muted-foreground",
  blocked: "text-warning-foreground",
  usage_limited: "text-warning",
  budget_limited: "text-warning",
  complete: "text-success",
};

function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function GoalsBody() {
  const { data, composerRef } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const openThread = useOpenThread();
  const goals = data.threads.filter((t) => t.goal !== null && t.goal.status !== "complete");
  if (goals.length === 0) {
    return (
      <WidgetEmpty
        scene="lighthouse"
        title="No goals running"
        hint="A goal keeps an agent going across turns until the objective is met."
        action={{
          label: "Start with /goal",
          onClick: () => writeToComposer(composerRef, "/goal "),
        }}
      />
    );
  }
  const shown = goals.slice(0, Math.max(1, Math.floor((bodyHeight - 4) / 56)));
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((t) => {
        const goal = t.goal!;
        const budget = goal.tokenBudget ?? null;
        const share =
          budget && goal.tokensUsed !== undefined ? Math.min(1, goal.tokensUsed / budget) : null;
        return (
          <Row
            key={t.key}
            onClick={() => openThread(t)}
            className="h-14 flex-col items-stretch justify-center gap-1"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn("shrink-0 text-xs font-medium capitalize", GOAL_TONE[goal.status])}
              >
                {goal.status.replace("_", " ")}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">{goal.objective}</span>
            </span>
            <span className="flex items-center gap-2 text-xs tabular-nums text-secondary-label">
              {share !== null ? (
                <span className="h-1 w-24 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      share > 0.85 ? "bg-warning" : "bg-info",
                    )}
                    style={{ width: `${Math.round(share * 100)}%` }}
                  />
                </span>
              ) : null}
              {goal.tokensUsed !== undefined ? (
                <span>
                  {compact(goal.tokensUsed)}
                  {budget ? ` / ${compact(budget)}` : ""} tokens
                </span>
              ) : null}
              {goal.timeUsedSeconds !== undefined ? (
                <span>· {Math.round(goal.timeUsedSeconds / 60)}m</span>
              ) : null}
            </span>
          </Row>
        );
      })}
      <More n={goals.length - shown.length} label="goals" />
    </div>
  );
}

const KIND_ICON = {
  subagent: BotIcon,
  command: SquareTerminalIcon,
  monitor: TelescopeIcon,
} as const;
const KIND_LABEL: Record<string, string> = {
  subagent: "Subagent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Task",
};

export function BackgroundBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const openThread = useOpenThread();
  const tasks = data.threads.flatMap((t) =>
    t.background.map((task, i) => ({ thread: t, task, key: `${t.key}:${i}` })),
  );
  if (tasks.length === 0) {
    return (
      <WidgetEmpty
        scene="rafted"
        title="Nothing in the background"
        hint="Subagents, monitors and long commands your agents leave running show up here."
      />
    );
  }
  const shown = tasks.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map(({ thread, task, key }) => {
        const Icon = KIND_ICON[task.kind as keyof typeof KIND_ICON] ?? SquareTerminalIcon;
        return (
          <Row key={key} onClick={() => openThread(thread)}>
            <Icon aria-hidden className="size-3.5 shrink-0 text-info" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {task.description ?? KIND_LABEL[task.kind]}
            </span>
            {size === "s" ? null : (
              <span className="max-w-[10rem] shrink-0 truncate text-xs text-muted-foreground">
                {thread.title}
              </span>
            )}
          </Row>
        );
      })}
      <More n={tasks.length - shown.length} label="running" />
    </div>
  );
}

export function BranchesBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const byBranch = new Map<string, ProtoThread[]>();
  for (const t of data.projectThreads) {
    if (!t.branch) continue;
    byBranch.set(t.branch, [...(byBranch.get(t.branch) ?? []), t]);
  }
  const branches = [...byBranch.entries()]
    .map(([branch, threads]) => ({ branch, threads, latest: threads[0]! }))
    .sort((a, b) => Date.parse(b.latest.updatedAt) - Date.parse(a.latest.updatedAt));
  if (branches.length === 0) {
    return (
      <WidgetEmpty
        scene="dock"
        title="No branches yet"
        hint="Threads that work on a branch or worktree are grouped here."
      />
    );
  }
  const shown = branches.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map(({ branch, threads, latest }) => {
        const pr = threads.flatMap((t) => t.prs)[0];
        return (
          <Row key={branch} onClick={() => openThread(latest)}>
            <GitBranchIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0",
                latest.worktreePath ? "text-info" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {branch}
            </span>
            {pr && size !== "s" ? (
              <span
                className={cn(
                  "shrink-0 text-xs",
                  PULL_REQUEST_STATE_PRESENTATION[pr.isDraft ? "draft" : pr.state].toneClassName,
                )}
              >
                #{pr.number}
              </span>
            ) : null}
            {threads.length > 1 && size !== "s" ? (
              <span className="shrink-0 text-xs tabular-nums text-secondary-label">
                {threads.length} threads
              </span>
            ) : null}
            <Time>{ago(latest.updatedAt, now)}</Time>
          </Row>
        );
      })}
      <More n={branches.length - shown.length} label="branches" />
    </div>
  );
}

export function TodayBody() {
  const { data } = useWidgetEnv();
  const { size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const since = startOfDay(now);
  const isToday = (iso: string | null) => iso !== null && Date.parse(iso) >= since;
  const started = data.threads.filter((t) => isToday(t.createdAt)).length;
  const finished = data.threads.filter((t) => t.status === "ready" && isToday(t.finishedAt)).length;
  const prs = new Set(
    data.threads.flatMap((t) => t.prs.filter((pr) => isToday(pr.updatedAt)).map((pr) => pr.key)),
  ).size;
  const stats = [
    { label: "Started", value: started },
    { label: "Finished", value: finished },
    { label: "PRs touched", value: prs },
  ];
  return (
    <dl
      className={cn(
        "grid h-full content-center gap-x-4 gap-y-3 px-3",
        size === "s" ? "grid-cols-1" : "grid-cols-3",
      )}
    >
      {stats.slice(0, size === "s" ? 2 : 3).map((stat) => (
        <div key={stat.label} className="flex flex-col gap-0.5">
          <dt className="text-xs text-secondary-label">{stat.label}</dt>
          <dd className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ModelMixBody() {
  const { data } = useWidgetEnv();
  const { size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const recent = data.threads.filter((t) => Date.parse(t.createdAt) >= now - 7 * DAY_MS);
  const counts = new Map<string, number>();
  for (const t of recent) {
    const key = t.model ?? t.providerInstanceId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    return (
      <WidgetEmpty
        scene="horizon"
        title="No threads this week"
        hint="Which models your agents ran on shows up here."
      />
    );
  }
  const total = recent.length;
  const shades = [
    "bg-foreground/80",
    "bg-foreground/55",
    "bg-foreground/35",
    "bg-foreground/20",
    "bg-foreground/10",
  ];
  const top = rows.slice(0, size === "s" ? 3 : 5);
  return (
    <div className="flex h-full flex-col justify-center gap-3 px-3">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={top.map(([m, n]) => `${m} ${n}`).join(", ")}
      >
        {top.map(([model, n], i) => (
          <span key={model} className={shades[i]} style={{ width: `${(n / total) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-col gap-1">
        {top.map(([model, n], i) => (
          <li key={model} className="flex items-center gap-2 text-xs">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", shades[i])} />
            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{model}</span>
            <span className="shrink-0 tabular-nums text-secondary-label">
              {Math.round((n / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SCRATCH_KEY = "supacode:proto:new-thread:scratchpad";

export function ScratchpadBody() {
  const { composerRef } = useWidgetEnv();
  const { preview } = useWidgetFrame();
  const [text, setText] = useState(() => window.localStorage.getItem(SCRATCH_KEY) ?? "");
  const update = (value: string) => {
    setText(value);
    window.localStorage.setItem(SCRATCH_KEY, value);
  };
  return (
    <div className="flex h-full flex-col gap-1.5 px-2 pt-0.5">
      <textarea
        value={text}
        onChange={(event) => update(event.target.value)}
        placeholder="Ideas for later, half-written prompts, things to check…"
        aria-label="Scratchpad"
        tabIndex={preview ? -1 : undefined}
        className="min-h-0 flex-1 resize-none rounded-md bg-transparent text-base leading-relaxed text-foreground outline-none placeholder:text-placeholder sm:text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-secondary-label">
          {text.trim()
            ? `${text.trim().split(/\s+/).length} words · saved on this device`
            : "Saved on this device"}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={!text.trim()}
          tabIndex={preview ? -1 : undefined}
          onClick={() => writeToComposer(composerRef, text.trim())}
        >
          Send to prompt
        </Button>
      </div>
    </div>
  );
}

export function ProjectsBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size, preview } = useWidgetFrame();
  const now = useNowMinuteMs();
  const projects = useProjects();
  const startThread = useNewThreadHandler();
  const rows = projects
    .map((project) => {
      const threads = data.threads.filter(
        (t) => t.environmentId === project.environmentId && t.projectId === project.id,
      );
      return {
        project,
        working: threads.filter((t) => IN_FLIGHT.has(t.status)).length,
        waiting: threads.filter((t) => NEEDS_YOU.has(t.status)).length,
        lastActive: threads[0]?.updatedAt ?? project.updatedAt,
        current:
          data.project?.environmentId === project.environmentId && data.project.id === project.id,
      };
    })
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  if (rows.length === 0) {
    return (
      <WidgetEmpty
        scene="dock"
        title="No projects"
        hint="Add a project from the sidebar to start a thread in it."
      />
    );
  }
  const shown = rows.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((row) => (
        <Row
          key={`${row.project.environmentId}:${row.project.id}`}
          onClick={
            preview || row.current
              ? undefined
              : () => void startThread(scopeProjectRef(row.project.environmentId, row.project.id))
          }
        >
          <ProjectFavicon project={row.project} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-foreground">{row.project.title}</span>
          {row.current ? <span className="shrink-0 text-xs text-secondary-label">here</span> : null}
          {row.waiting > 0 ? (
            <span className="shrink-0 rounded-sm bg-warning/15 px-1 text-2xs font-medium tabular-nums text-warning-foreground">
              {row.waiting}
            </span>
          ) : null}
          {row.working > 0 && size !== "s" ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-info">
              <span aria-hidden className="size-1.5 rounded-full bg-info" />
              {row.working}
            </span>
          ) : null}
          <Time>{ago(row.lastActive, now)}</Time>
        </Row>
      ))}
      <More n={rows.length - shown.length} label="projects" />
    </div>
  );
}
