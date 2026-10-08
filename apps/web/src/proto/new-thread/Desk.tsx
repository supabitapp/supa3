import {
  ActivityIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  HandIcon,
  MessageSquareIcon,
  RadioIcon,
  type LucideIcon,
} from "lucide-react";
import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { useDiscoveredPortsState } from "../../portDiscoveryState";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  IN_FLIGHT,
  NEEDS_YOU,
  ago,
  shortRepo,
  uniqueOpenPrs,
  useOpenThread,
  type ProtoData,
  type ProtoPr,
  type ProtoThread,
} from "./data";

export const STATUS_TONE: Record<ProtoThread["status"], { label: string; className: string }> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  failed: { label: "Failed", className: "text-error" },
  limited: { label: "Limited", className: "text-warning" },
  working: { label: "Working", className: "text-info" },
  waiting: { label: "Waiting", className: "text-info" },
  ready: { label: "Done", className: "text-success" },
};

const ROW_LIMIT = 6;

export function Desk({ data }: { data: ProtoData }) {
  const now = useNowMinuteMs();
  const environmentId = data.project?.environmentId ?? null;
  const services = useDiscoveredPortsState(environmentId).servers;
  const openThread = useOpenThread();
  const needsYou = data.threads.filter((t) => NEEDS_YOU.has(t.status));
  const working = data.threads.filter((t) => IN_FLIGHT.has(t.status));
  const finished = data.threads
    .filter((t) => t.status === "ready" && t.finishedAt !== null)
    .sort(
      (a, b) =>
        Number(b.unread) - Number(a.unread) ||
        Date.parse(b.finishedAt ?? "") - Date.parse(a.finishedAt ?? ""),
    );
  const prs = uniqueOpenPrs(data.threads);
  const threadById = new Map(data.threads.map((t) => [t.id, t]));

  const quiet = [
    needsYou.length === 0 && "Nothing needs you",
    working.length === 0 && "No agents working",
    prs.length === 0 && "No open pull requests",
    services.length === 0 && "No dev servers listening",
  ].filter(Boolean);

  const threadRow = (thread: ProtoThread, trailing: ReactNode) => (
    <li key={thread.key}>
      <button
        type="button"
        onClick={() => openThread(thread)}
        className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-current",
            STATUS_TONE[thread.status].className,
          )}
        />
        <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
        <span className="max-w-[9rem] shrink-0 truncate text-xs text-muted-foreground">
          {thread.projectName}
        </span>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-secondary-label">
          {trailing}
        </span>
      </button>
    </li>
  );

  const leftColumn = [
    needsYou.length > 0 && (
      <Section key="needs" icon={HandIcon} title="Needs you" count={needsYou.length}>
        {needsYou.slice(0, ROW_LIMIT).map((t) => (
          <li key={t.key}>
            <button
              type="button"
              onClick={() => openThread(t)}
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
            >
              <span className="flex w-full min-w-0 items-center gap-2.5 text-sm">
                <span
                  className={cn("shrink-0 text-xs font-medium", STATUS_TONE[t.status].className)}
                >
                  {STATUS_TONE[t.status].label}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-secondary-label">
                  {ago(t.updatedAt, now)}
                </span>
              </span>
              {t.lastError && t.status === "failed" ? (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {t.lastError}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </Section>
    ),
    working.length > 0 && (
      <Section key="working" icon={ActivityIcon} title="Working now" count={working.length}>
        {working.slice(0, ROW_LIMIT).map((t) => threadRow(t, ago(t.activeSince, now)))}
      </Section>
    ),
    finished.length > 0 && (
      <Section
        key="finished"
        icon={CheckCheckIcon}
        title="Recently finished"
        count={finished.length}
      >
        {finished.slice(0, ROW_LIMIT).map((t) =>
          threadRow(
            t,
            <span className="inline-flex items-center gap-1">
              {t.unread ? (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-info" />
                  <span className="sr-only">Unread,</span>
                </>
              ) : null}
              {ago(t.finishedAt, now)}
            </span>,
          ),
        )}
      </Section>
    ),
  ].filter(Boolean);

  const rightColumn = [
    prs.length > 0 && (
      <Section
        key="prs"
        icon={PullRequestGlyph.pullRequest}
        title="Pull requests"
        count={prs.length}
      >
        {prs.slice(0, ROW_LIMIT).map((pr) => {
          const Icon = pr.isDraft ? PullRequestGlyph.draft : PullRequestGlyph.pullRequest;
          return (
            <li key={pr.key}>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0",
                    pr.isDraft ? "text-muted-foreground" : "text-success",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{pr.title}</span>
                {pr.conflicting ? (
                  <span className="shrink-0 text-xs text-error">Conflicts</span>
                ) : null}
                {pr.changesRequested ? (
                  <MessageSquareIcon
                    aria-label="Changes requested"
                    className="size-3.5 shrink-0 text-warning-foreground"
                  />
                ) : null}
                <ChecksIcon checks={pr.checks} />
                <span className="shrink-0 font-mono text-xs text-secondary-label">
                  {shortRepo(pr.repository)}#{pr.number}
                </span>
              </a>
            </li>
          );
        })}
      </Section>
    ),
    services.length > 0 && (
      <Section key="services" icon={RadioIcon} title="Running services" count={services.length}>
        {services.slice(0, ROW_LIMIT).map((server) => {
          const owner = server.terminal ? threadById.get(server.terminal.threadId) : undefined;
          return (
            <li key={server.url}>
              <a
                href={
                  environmentId ? resolveDiscoveredServerUrl(environmentId, server.url) : server.url
                }
                target="_blank"
                rel="noreferrer"
                className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
                <span className="w-14 shrink-0 font-mono text-xs tabular-nums text-foreground">
                  :{server.port}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {owner?.title ?? server.processName ?? server.host}
                </span>
              </a>
            </li>
          );
        })}
      </Section>
    ),
  ].filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-5 pt-4 pb-2">
      {leftColumn.length + rightColumn.length > 0 ? (
        <div className="grid items-start gap-3 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">{leftColumn}</div>
          <div className="flex min-w-0 flex-col gap-3">{rightColumn}</div>
        </div>
      ) : null}
      {quiet.length > 0 ? (
        <p className="px-1 text-xs text-secondary-label">{quiet.join(" · ")}</p>
      ) : null}
    </div>
  );
}

export function ChecksIcon({ checks }: { checks: ProtoPr["checks"] }) {
  if (checks === "failing") {
    return <CircleXIcon aria-label="Checks failing" className="size-3.5 shrink-0 text-error" />;
  }
  if (checks === "passing") {
    return <CheckIcon aria-label="Checks passing" className="size-3.5 shrink-0 text-success" />;
  }
  if (checks === "pending") {
    return <CircleDashedIcon aria-label="Checks running" className="size-3.5 shrink-0 text-info" />;
  }
  return <span aria-hidden className="size-3.5 shrink-0" />;
}

function Section(props: { icon: LucideIcon; title: string; count: number; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <section className="rounded-xl bg-card p-1.5 shadow-xs/5 ring-1 ring-border/70">
      <header className="flex h-7 items-center gap-2 px-2.5 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        <h2>{props.title}</h2>
        <span className="tabular-nums text-secondary-label">{props.count}</span>
      </header>
      <ul className="flex flex-col">{props.children}</ul>
      {props.count > ROW_LIMIT ? (
        <p className="px-2.5 pt-1 pb-0.5 text-xs text-secondary-label">
          and {props.count - ROW_LIMIT} more
        </p>
      ) : null}
    </section>
  );
}
