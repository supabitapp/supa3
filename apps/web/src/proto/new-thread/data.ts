import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@supacode/client-runtime/state/shell";
import { scopeThreadRef } from "@supacode/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@supacode/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  hasUnseenCompletion,
  isSidebarSubagentThread,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../../components/Sidebar.logic";
import { useProjects, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";

export interface ProtoPr {
  readonly key: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly conflicting: boolean;
  readonly checks: "passing" | "failing" | "pending" | null;
  readonly changesRequested: boolean;
  readonly updatedAt: string | null;
}

export interface ProtoThread {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly title: string;
  readonly branch: string | null;
  readonly status: SidebarThreadStatus;
  readonly unread: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeSince: string | null;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
  readonly prs: ReadonlyArray<ProtoPr>;
  readonly pinnedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly goal: EnvironmentThreadShell["goal"];
  readonly background: ReadonlyArray<{ kind: string; description: string | null }>;
  readonly worktreePath: string | null;
  readonly model: string | null;
  readonly providerInstanceId: string;
}

export interface ProtoData {
  readonly project: EnvironmentProject | null;
  readonly threads: ReadonlyArray<ProtoThread>;
  readonly projectThreads: ReadonlyArray<ProtoThread>;
}

export const NEEDS_YOU: ReadonlySet<SidebarThreadStatus> = new Set([
  "approval",
  "input",
  "failed",
  "limited",
]);
export const IN_FLIGHT: ReadonlySet<SidebarThreadStatus> = new Set(["working", "waiting"]);

function toProtoThread(shell: EnvironmentThreadShell, projectName: string): ProtoThread {
  const key = `${shell.environmentId}:${shell.id}`;
  return {
    key,
    environmentId: shell.environmentId,
    id: shell.id,
    projectId: shell.projectId,
    projectName,
    title: shell.title,
    branch: shell.branch,
    status: resolveSidebarThreadStatus(shell),
    unread: hasUnseenCompletion(shell),
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    activeSince: shell.runtime?.activityStartedAt ?? shell.latestRun?.startedAt ?? null,
    finishedAt: shell.latestRun?.completedAt ?? null,
    lastError: shell.runtime?.lastError ?? null,
    pinnedAt: shell.pinnedAt,
    snoozedUntil: shell.snoozedUntil,
    goal: shell.goal,
    background: shell.pendingBackgroundTasks.map((task) => ({
      kind: task.kind,
      description: task.description ?? null,
    })),
    worktreePath: shell.worktreePath,
    model: shell.modelSelection?.model ?? null,
    providerInstanceId: shell.providerInstanceId,
    prs: shell.pullRequests.flatMap((link) =>
      link.source === "stack-dismissed" || link.snapshot === null
        ? []
        : [
            {
              key: `${link.repository}#${link.number}`,
              repository: link.repository,
              number: link.number,
              url: link.url,
              title: link.snapshot.title,
              state: link.snapshot.state,
              isDraft: link.snapshot.isDraft,
              conflicting: link.snapshot.mergeability === "conflicting",
              checks: link.snapshot.checksState ?? null,
              changesRequested: link.snapshot.reviewDecision === "changes-requested",
              updatedAt: link.snapshot.updatedAt,
            },
          ],
    ),
  };
}

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

// Real titles, branches, and PRs; only the statuses are invented, so every
// variant can be judged under load without starting real agents.
function simulateBusyDay(threads: ReadonlyArray<ProtoThread>, now: number): ProtoThread[] {
  return threads.map((thread, index) => {
    if (index === 0) return { ...thread, status: "approval", updatedAt: minutesAgo(now, 2) };
    if (index === 1) return { ...thread, status: "input", updatedAt: minutesAgo(now, 9) };
    if (index >= 2 && index < 6) {
      return {
        ...thread,
        status: "working",
        activeSince: minutesAgo(now, 4 + index * 9),
        goal:
          index === 3
            ? {
                objective: `Finish ${thread.title.toLowerCase()} with tests passing`,
                status: "active",
                tokensUsed: 412_000,
                tokenBudget: 1_000_000,
                timeUsedSeconds: 2_940,
              }
            : thread.goal,
        background:
          index === 4
            ? [
                { kind: "subagent", description: "Review the migration for data loss" },
                { kind: "command", description: "vp run dev" },
              ]
            : thread.background,
        prs: thread.prs.map((pr, prIndex) =>
          prIndex === 0 && index === 2 ? { ...pr, state: "open", conflicting: true } : pr,
        ),
      };
    }
    if (index === 6) {
      return {
        ...thread,
        status: "failed",
        lastError: "Process exited with code 1 while running `vp test run`",
        finishedAt: minutesAgo(now, 31),
      };
    }
    if (index < 12) {
      return {
        ...thread,
        status: "ready",
        unread: index < 10,
        pinnedAt: index === 7 || index === 9 ? minutesAgo(now, 600) : thread.pinnedAt,
        finishedAt: minutesAgo(now, 12 + index * 17),
        prs: thread.prs.map((pr) =>
          index === 7 ? { ...pr, state: "open", checks: "failing" } : pr,
        ),
      };
    }
    if (index === 12)
      return { ...thread, snoozedUntil: new Date(now + 3 * 3_600_000).toISOString() };
    return thread;
  });
}

export function useProtoData(project: EnvironmentProject | null, busy: boolean): ProtoData {
  const projects = useProjects();
  const shells = useThreadShells();
  const [simulatedAt] = useState(() => Date.now());

  return useMemo(() => {
    const projectNames = new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p.title]));
    const live = shells
      .filter((shell) => shell.deletedAt === null && shell.archivedAt === null)
      .filter((shell) => !isSidebarSubagentThread(shell))
      .map((shell) =>
        toProtoThread(
          shell,
          projectNames.get(`${shell.environmentId}:${shell.projectId}`) ?? "No project",
        ),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const threads = busy ? simulateBusyDay(live, simulatedAt) : live;
    const projectThreads = project
      ? threads.filter(
          (t) => t.environmentId === project.environmentId && t.projectId === project.id,
        )
      : threads;
    return { project, threads, projectThreads };
  }, [busy, project, projects, shells, simulatedAt]);
}

export function useOpenThread() {
  const navigate = useNavigate();
  return (thread: Pick<ProtoThread, "environmentId" | "id">) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function agoPhrase(iso: string | null, now: number): string {
  const value = ago(iso, now);
  return value === "now" ? "just now" : `${value} ago`;
}

export function uniqueOpenPrs(threads: ReadonlyArray<ProtoThread>): ProtoPr[] {
  const seen = new Map<string, ProtoPr>();
  for (const thread of threads) {
    for (const pr of thread.prs) {
      if (pr.state !== "open" || seen.has(pr.key)) continue;
      seen.set(pr.key, pr);
    }
  }
  return [...seen.values()];
}

export function shortRepo(repository: string): string {
  return repository.split("/").at(-1) ?? repository;
}

export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
