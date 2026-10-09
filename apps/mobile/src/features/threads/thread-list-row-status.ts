import type { AppSymbolName } from "../../components/AppSymbol";
import type { ThreadListV2Status } from "./threadListV2";

export interface ThreadListV2RowStatusLabel {
  readonly label: string;
  readonly className: string;
  /** Live statuses carry the web sidebar's glyph; Connecting does not. */
  readonly icon?: AppSymbolName;
  readonly iconTintClassName?: string;
}

// Status hues follow the system-wide convention set by the sidebar and the
// Live Activity/widgets (amber approval, indigo input, sky working).
const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, ThreadListV2RowStatusLabel>> = {
  approval: {
    label: "Approval",
    className: "text-warning-foreground",
    icon: "exclamationmark.shield",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    className: "text-adaptive-indigo-600-300",
    icon: "questionmark.bubble",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  working: {
    label: "Working",
    className: "text-adaptive-sky-600-400",
    icon: "circle.dashed",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  waiting: {
    label: "Waiting",
    className: "text-adaptive-sky-600-400",
    icon: "circle.dashed",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  failed: {
    label: "Failed",
    className: "text-danger-foreground",
    icon: "exclamationmark.circle",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    className: "text-warning-foreground",
    icon: "exclamationmark.circle",
    iconTintClassName: "accent-warning-foreground",
  },
};

const DONE_STATUS_LABEL: ThreadListV2RowStatusLabel = {
  label: "Done",
  className: "text-adaptive-emerald-700-300",
  icon: "checkmark.circle",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

/** Cached work status becomes live again only after its environment connects.
 * Waiting on subagents or monitors keeps the row's working tone. */
export function resolveThreadListV2RowStatusLabel(input: {
  readonly environmentConnected: boolean;
  readonly status: ThreadListV2Status;
  readonly isUnread: boolean;
  readonly goalActive: boolean;
  readonly mutedClassName: string;
}): ThreadListV2RowStatusLabel | undefined {
  if (!input.environmentConnected) return { label: "Connecting", className: input.mutedClassName };
  const label = STATUS_LABEL_BY_STATUS[input.status];
  // A native /goal keeps the agent going across turns until it is met.
  if (label && input.status === "working" && input.goalActive) return { ...label, label: "Goal" };
  if (label) return label;
  if (input.isUnread) return DONE_STATUS_LABEL;
  return undefined;
}
