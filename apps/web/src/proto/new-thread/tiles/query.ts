import {
  DAY_MS,
  NEEDS_YOU,
  shortRepo,
  type ProtoData,
  type ProtoPr,
  type ProtoThread,
} from "../data";
import { STATUS_TONE } from "../Desk";
import type { PrFilter, ThreadFilter, TileProps, TileQuery } from "./spec";

const age = (iso: string | null, now: number) =>
  iso ? (now - Date.parse(iso)) / DAY_MS : Number.POSITIVE_INFINITY;

function pool(data: ProtoData, where: Pick<ThreadFilter, "scope" | "project">) {
  if (where.project) {
    const name = where.project.toLowerCase();
    return data.threads.filter((t) => t.projectName.toLowerCase() === name);
  }
  return where.scope === "all" ? data.threads : data.projectThreads;
}

function matchesStatus(thread: ProtoThread, statuses: ThreadFilter["status"]) {
  if (!statuses || statuses.length === 0) return true;
  return statuses.some((status) =>
    status === "needs-you" ? NEEDS_YOU.has(thread.status) : thread.status === status,
  );
}

const includes = (value: string | null, needle: string | undefined) =>
  !needle || (value ?? "").toLowerCase().includes(needle.toLowerCase());

export function selectThreads(data: ProtoData, where: ThreadFilter = {}, now: number) {
  return pool(data, where).filter(
    (t) =>
      matchesStatus(t, where.status) &&
      (where.unread === undefined || (t.status === "ready" && t.unread) === where.unread) &&
      (where.pinned === undefined || (t.pinnedAt !== null) === where.pinned) &&
      (where.planReady === undefined || t.planReady === where.planReady) &&
      (where.hasOpenPr === undefined ||
        t.prs.some((pr) => pr.state === "open") === where.hasOpenPr) &&
      (where.createdWithinDays === undefined || age(t.createdAt, now) <= where.createdWithinDays) &&
      (where.updatedWithinDays === undefined || age(t.updatedAt, now) <= where.updatedWithinDays) &&
      (where.updatedOlderThanDays === undefined ||
        age(t.updatedAt, now) >= where.updatedOlderThanDays) &&
      includes(t.model, where.model) &&
      includes(t.title, where.titleIncludes),
  );
}

type TilePr = ProtoPr & { readonly projectName: string };

export function selectPullRequests(data: ProtoData, where: PrFilter = {}, now: number) {
  const seen = new Map<string, TilePr>();
  for (const thread of pool(data, where))
    for (const pr of thread.prs)
      if (!seen.has(pr.key)) seen.set(pr.key, { ...pr, projectName: thread.projectName });
  return [...seen.values()].filter(
    (pr) =>
      (where.state === undefined ||
        (where.state === "draft" ? pr.state === "open" && pr.isDraft : pr.state === where.state)) &&
      (where.checks === undefined || pr.checks === where.checks) &&
      (where.conflicting === undefined || pr.conflicting === where.conflicting) &&
      (where.changesRequested === undefined || pr.changesRequested === where.changesRequested) &&
      (where.updatedWithinDays === undefined || age(pr.updatedAt, now) <= where.updatedWithinDays),
  );
}

export const countQuery = (data: ProtoData, query: TileQuery, now: number) =>
  query.source === "threads"
    ? selectThreads(data, query.where, now).length
    : selectPullRequests(data, query.where, now).length;

const THREAD_GROUP = {
  project: (t: ProtoThread) => t.projectName,
  model: (t: ProtoThread) => t.model ?? "Default model",
  status: (t: ProtoThread) => STATUS_TONE[t.status].label,
  provider: (t: ProtoThread) => t.providerInstanceId,
  repository: (t: ProtoThread) => (t.prs[0] ? shortRepo(t.prs[0].repository) : "No repository"),
};

const PR_GROUP = {
  project: (pr: TilePr) => pr.projectName,
  status: (pr: TilePr) => (pr.isDraft && pr.state === "open" ? "draft" : pr.state),
  repository: (pr: TilePr) => shortRepo(pr.repository),
  checks: (pr: TilePr) => pr.checks ?? "no checks",
};

export function groupQuery(data: ProtoData, props: TileProps<"BarList">, now: number) {
  const labels =
    props.source === "threads"
      ? selectThreads(data, props.where, now).map(THREAD_GROUP[props.groupBy])
      : selectPullRequests(data, props.where, now).map(PR_GROUP[props.groupBy]);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}
