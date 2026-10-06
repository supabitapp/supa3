import { EnvironmentId, ProviderInstanceId, ThreadId } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import { splitHomeThreadSections } from "./home-thread-sections";

const now = "2026-10-06T12:00:00.000Z";
const environmentId = EnvironmentId.make("environment-test");
const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: now,
};
const thread = (id: string, overrides: Parameters<typeof makeThreadShellFixture>[0] = {}) =>
  makeThreadShellFixture({ id: ThreadId.make(id), title: id, ...overrides });
const threads = [
  thread("pinned-working", { runtime: running, pinnedAt: now }),
  thread("needs-approval", { runtime: running, hasPendingApprovals: true }),
  thread("working", { runtime: running }),
  thread("snoozed", { snoozedUntil: "2026-10-07T12:00:00.000Z", snoozedAt: now }),
  thread("settled", { settledOverride: "settled", settledAt: now }),
];

function list(expanded: boolean) {
  const layout = buildThreadListV2Items({
    threads,
    environmentId,
    searchQuery: "",
    now,
    workingShelfExpanded: expanded,
    snoozedShelfExpanded: expanded,
    settledShelfExpanded: expanded,
  });
  return buildThreadListV2ListItems({
    ...layout,
    pendingTasks: [],
    workingShelfExpanded: expanded,
    snoozedShelfExpanded: expanded,
    settledShelfExpanded: expanded,
  });
}

const ids = (items: ReadonlyArray<ThreadListV2ListItem>) =>
  items.flatMap((item) => (item.type === "v2-thread" ? [item.item.thread.id] : []));

describe("Home thread sections", () => {
  it("keeps pinned work and approvals in the inbox while separating secondary rows", () => {
    const items = list(true);
    const sections = splitHomeThreadSections(items);
    expect(ids(sections.active)).toEqual(["pinned-working", "needs-approval"]);
    expect(ids(sections.working)).toEqual(["working"]);
    expect(ids(sections.snoozed)).toEqual(["snoozed"]);
    expect(ids(sections.settled)).toEqual(["settled"]);
    for (const rows of Object.values(sections)) {
      for (const row of rows) expect(items).toContain(row);
    }
  });

  it("leaves the inbox order intact when all secondary categories are closed", () => {
    const sections = splitHomeThreadSections(list(false));
    expect(ids(sections.active)).toEqual(["pinned-working", "needs-approval"]);
    expect(sections.working).toEqual([]);
    expect(sections.snoozed).toEqual([]);
    expect(sections.settled).toEqual([]);
  });
});
