import {
  CircleAlertIcon,
  CircleXIcon,
  HistoryIcon,
  MessageSquareIcon,
  type LucideIcon,
} from "lucide-react";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";

import type { ComposerHandleRef } from "../../composerHandleContext";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import {
  IN_FLIGHT,
  NEEDS_YOU,
  agoPhrase,
  shortRepo,
  uniqueOpenPrs,
  useOpenThread,
  type ProtoData,
  type ProtoThread,
} from "./data";

export interface Starter {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly tone: string;
  readonly reason: string;
  readonly prompt: string;
}

const STARTER_LIMIT = 4;

export function buildStarters(data: ProtoData, now: number, limit = STARTER_LIMIT): Starter[] {
  const prs = uniqueOpenPrs(data.projectThreads);
  const kinds: Starter[][] = [
    prs
      .filter((pr) => pr.conflicting)
      .map((pr) => ({
        key: `conflict:${pr.key}`,
        icon: PullRequestGlyph.conflicting,
        tone: "text-error",
        reason: `Conflicts · ${shortRepo(pr.repository)}#${pr.number}`,
        prompt: `Rebase #${pr.number} (“${pr.title}”) on its base branch, resolve the conflicts, and push.`,
      })),
    prs
      .filter((pr) => pr.checks === "failing")
      .map((pr) => ({
        key: `checks:${pr.key}`,
        icon: CircleXIcon,
        tone: "text-error",
        reason: `Checks failing · ${shortRepo(pr.repository)}#${pr.number}`,
        prompt: `The checks on #${pr.number} (“${pr.title}”) are failing. Read the logs, fix the cause, and push.`,
      })),
    prs
      .filter((pr) => pr.changesRequested)
      .map((pr) => ({
        key: `review:${pr.key}`,
        icon: MessageSquareIcon,
        tone: "text-warning-foreground",
        reason: `Changes requested · ${shortRepo(pr.repository)}#${pr.number}`,
        prompt: `Address the requested changes on #${pr.number} (“${pr.title}”) and reply to each review comment.`,
      })),
    data.projectThreads
      .filter((t) => t.status === "failed")
      .map((t) => ({
        key: `failed:${t.key}`,
        icon: CircleAlertIcon,
        tone: "text-error",
        reason: `Failed ${agoPhrase(t.finishedAt ?? t.updatedAt, now)}`,
        prompt: `“${t.title}” stopped with an error${t.lastError ? `: ${t.lastError}` : ""}. Find the cause and fix it.`,
      })),
    data.projectThreads
      .filter((t) => t.status === "ready" && t.prs.length === 0 && t.branch)
      .map((t) => ({
        key: `pr:${t.key}`,
        icon: PullRequestGlyph.pullRequest,
        tone: "text-success",
        reason: `No pull request yet · ${t.branch}`,
        prompt: `Open a pull request for the work in “${t.title}”.`,
      })),
    data.projectThreads
      .filter((t) => t.status === "ready")
      .map((t) => ({
        key: `continue:${t.key}`,
        icon: HistoryIcon,
        tone: "text-muted-foreground",
        reason: `Last touched ${agoPhrase(t.updatedAt, now)}`,
        prompt: `Pick up where “${t.title}” left off. Check what's done and finish the rest.`,
      })),
  ];
  const picked: Starter[] = [];
  const usedThreads = new Set<string>();
  for (let round = 0; picked.length < limit && round < limit; round++) {
    for (const kind of kinds) {
      const next = kind.find((s) => !usedThreads.has(s.key.slice(s.key.indexOf(":") + 1)));
      if (!next || picked.length >= limit) continue;
      usedThreads.add(next.key.slice(next.key.indexOf(":") + 1));
      picked.push(next);
    }
  }
  return picked;
}

function summary(
  threads: ReadonlyArray<ProtoThread>,
): Array<{ text: string; thread?: ProtoThread }> {
  const working = threads.filter((t) => IN_FLIGHT.has(t.status));
  const needsYou = threads.filter((t) => NEEDS_YOU.has(t.status));
  const parts: Array<{ text: string; thread?: ProtoThread }> = [];
  if (working.length > 0) {
    parts.push({
      text: `${working.length} ${working.length === 1 ? "agent is" : "agents are"} working`,
      ...(working[0] ? { thread: working[0] } : {}),
    });
  }
  if (needsYou.length > 0) {
    parts.push({
      text: `${needsYou.length} ${needsYou.length === 1 ? "needs" : "need"} you`,
      ...(needsYou[0] ? { thread: needsYou[0] } : {}),
    });
  }
  return parts;
}

export function Launchpad({
  data,
  composerRef,
}: {
  data: ProtoData;
  composerRef: ComposerHandleRef;
}) {
  const now = useNowMinuteMs();
  const openThread = useOpenThread();
  const starters = buildStarters(data, now);
  const parts = summary(data.projectThreads);
  const projectName = data.project?.title ?? "this project";

  const applyPrompt = (prompt: string) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true });
    composer.focusAtEnd();
  };

  return (
    <div className="chat-composer-lane flex min-h-full flex-col justify-end">
      <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-5 pb-2">
        <div className="flex flex-col gap-1.5 px-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {data.project ? <ProjectFavicon project={data.project} className="size-4" /> : null}
            <span>{projectName}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance text-foreground">
            What’s next for {projectName}?
          </h1>
          {parts.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {parts.map((part, i) => (
                <span key={part.text}>
                  {i > 0 ? ", " : ""}
                  {part.thread ? (
                    <button
                      type="button"
                      onClick={() => part.thread && openThread(part.thread)}
                      className="rounded-sm text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {part.text}
                    </button>
                  ) : (
                    part.text
                  )}
                </span>
              ))}
              .
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing is running here. Start from something below or write your own.
            </p>
          )}
        </div>
        {starters.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {starters.map((starter) => {
              const Icon = starter.icon;
              return (
                <li key={starter.key} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => applyPrompt(starter.prompt)}
                    className="flex h-full w-full min-w-0 flex-col gap-1.5 rounded-xl bg-card p-3 text-left shadow-xs/5 ring-1 ring-border/70 outline-none transition-[background-color,box-shadow,transform] duration-150 ease-out hover:bg-accent/60 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon aria-hidden className={`size-3.5 shrink-0 ${starter.tone}`} />
                      <span className="truncate">{starter.reason}</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-foreground">{starter.prompt}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
