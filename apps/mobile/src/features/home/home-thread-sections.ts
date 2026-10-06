import type { ThreadListV2ListItem } from "../threads/threadListV2";

export type HomeThreadSection = "working" | "snoozed" | "settled";

/** Keeps the shared row order and actions while moving secondary shelves into the dock. */
export function splitHomeThreadSections(items: ReadonlyArray<ThreadListV2ListItem>) {
  const sections = {
    active: [] as ThreadListV2ListItem[],
    working: [] as ThreadListV2ListItem[],
    snoozed: [] as ThreadListV2ListItem[],
    settled: [] as ThreadListV2ListItem[],
  };
  let section: keyof typeof sections = "active";
  for (const item of items) {
    switch (item.type) {
      case "v2-working-shelf":
        section = "working";
        break;
      case "v2-snoozed-shelf":
        section = "snoozed";
        break;
      case "v2-settled-shelf":
        section = "settled";
        break;
      default:
        sections[section].push(item);
    }
  }
  return sections;
}
