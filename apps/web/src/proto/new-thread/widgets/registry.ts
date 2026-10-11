import {
  ActivityIcon,
  BotIcon,
  CalendarDaysIcon,
  ChartPieIcon,
  GitBranchIcon,
  KeyboardIcon,
  ArchiveIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  CoinsIcon,
  GaugeIcon,
  GitCommitHorizontalIcon,
  PlugZapIcon,
  ServerIcon,
  WandSparklesIcon,
  MoonIcon,
  NotebookPenIcon,
  FolderGit2Icon,
  PinIcon,
  SunriseIcon,
  TargetIcon,
  CheckCheckIcon,
  HandIcon,
  RadioIcon,
  SailboatIcon,
  SparklesIcon,
  Building2Icon,
  CloudSunIcon,
  HourglassIcon,
  InboxIcon,
  ListChecksIcon,
  MoonStarIcon,
  MountainIcon,
  ShipIcon,
  SproutIcon,
  TimerIcon,
  WavesIcon,
  PaintbrushIcon,
  type LucideIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../../../components/pullRequest/pullRequestIcons";
import type { ComponentType } from "react";

import { IN_FLIGHT, NEEDS_YOU, uniqueOpenPrs, type ProtoData } from "../data";
import {
  ActivityBody,
  FinishedBody,
  HarborBody,
  NeedsYouBody,
  PullRequestsBody,
  ServicesBody,
  StartersBody,
  WorkingBody,
} from "./bodies";
import {
  AutomationsBody,
  CheckoutBody,
  MachinesBody,
  ProvidersBody,
  ShortcutsBody,
  SkillsBody,
  SpendTodayBody,
  SpendWeekBody,
  StashBody,
  UsageLimitsBody,
} from "./appWidgets";
import {
  BackgroundBody,
  BranchesBody,
  GoalsBody,
  ModelMixBody,
  PinnedBody,
  ProjectsBody,
  ScratchpadBody,
  SnoozedBody,
  TodayBody,
} from "./threadWidgets";
import {
  ForecastBody,
  GardenBody,
  NightSkyBody,
  RidgelineBody,
  SkylineBody,
  TideBody,
} from "./artWidgets";
import { CatchUpBody, PausedBody, PlansBody, QuietBody, ShippedBody } from "./listWidgets";
import { AgentTileBody } from "../tiles/TileBody";
import { forgetTile, tileTitles } from "../tiles/store";
import type { WidgetSize } from "./layout";

export type WidgetCategory =
  | "Yours"
  | "Agents"
  | "Start"
  | "Code"
  | "Insights"
  | "Machine"
  | "Ambient";
export const CATEGORIES: ReadonlyArray<WidgetCategory> = [
  "Yours",
  "Agents",
  "Start",
  "Code",
  "Insights",
  "Machine",
  "Ambient",
];

export interface WidgetTitles {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: (id: string) => string | null;
}

export interface WidgetDef {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly category: WidgetCategory;
  readonly sizes: ReadonlyArray<WidgetSize>;
  readonly source: string;
  readonly bare?: boolean;
  readonly count?: (data: ProtoData) => { n: number; urgent?: boolean } | null;
  readonly Body: ComponentType;
  readonly multiple?: boolean;
  readonly titles?: WidgetTitles;
  readonly forget?: (id: string) => void;
}

const SHELLS = "Thread shells already on this client. No extra requests.";

const AGENT_TILE: WidgetDef = {
  id: "agent-tile",
  title: "Agent tile",
  description:
    "Describe what you want to see and an agent designs the tile from live data. Add as many as you like.",
  icon: PaintbrushIcon,
  category: "Yours",
  sizes: ["m", "s", "t", "l", "w"],
  source:
    "Your prompt, project names, model names and today's counts go to Claude once (10 to 30 seconds) to design the tile. Thread titles never leave the device. After that it reads data already on this client, so it stays current with no extra requests.",
  Body: AgentTileBody,
  multiple: true,
  titles: tileTitles,
  forget: forgetTile,
};

export const WIDGETS: ReadonlyArray<WidgetDef> = [
  AGENT_TILE,
  {
    id: "needs-you",
    title: "Needs you",
    description: "Threads waiting on an approval, an answer, or a failed run to look at.",
    icon: HandIcon,
    category: "Agents",
    sizes: ["m", "l", "t", "w"],
    source: SHELLS,
    count: (data) => {
      const n = data.threads.filter((t) => NEEDS_YOU.has(t.status)).length;
      return { n, urgent: n > 0 };
    },
    Body: NeedsYouBody,
  },
  {
    id: "working",
    title: "Working now",
    description: "Every agent mid-turn, and how long it has been at it.",
    icon: ActivityIcon,
    category: "Agents",
    sizes: ["m", "l", "t", "w"],
    source: SHELLS,
    count: (data) => ({ n: data.threads.filter((t) => IN_FLIGHT.has(t.status)).length }),
    Body: WorkingBody,
  },
  {
    id: "finished",
    title: "Recently finished",
    description: "Turns that just ended, unread ones first.",
    icon: CheckCheckIcon,
    category: "Agents",
    sizes: ["s", "m", "l", "t", "w"],
    source: SHELLS,
    count: (data) => ({ n: data.threads.filter((t) => t.status === "ready" && t.unread).length }),
    Body: FinishedBody,
  },
  {
    id: "starters",
    title: "Pick up",
    description:
      "Prompts built from what's broken or unfinished in this project. Click one to start.",
    icon: SparklesIcon,
    category: "Start",
    sizes: ["m", "l", "t", "w"],
    source: "Linked pull requests and thread outcomes in this project.",
    Body: StartersBody,
  },
  {
    id: "pull-requests",
    title: "Pull requests",
    description: "Open pull requests your threads are linked to, with checks and conflicts.",
    icon: PullRequestGlyph.pullRequest,
    category: "Code",
    sizes: ["m", "l", "t", "w"],
    source: "Pull request links on threads, from their last sync.",
    count: (data) => ({ n: uniqueOpenPrs(data.threads).length }),
    Body: PullRequestsBody,
  },
  {
    id: "activity",
    title: "Activity",
    description: "When this project's threads started over 16 weeks, and your streak.",
    icon: CalendarDaysIcon,
    category: "Insights",
    sizes: ["m", "l", "w"],
    source: "Thread start times in this project, computed on this client.",
    Body: ActivityBody,
  },
  {
    id: "services",
    title: "Running services",
    description: "Ports listening on this machine, with the thread that started them.",
    icon: RadioIcon,
    category: "Machine",
    sizes: ["s", "m", "t"],
    source: "Polls this machine's listening ports every few seconds while the widget is on screen.",
    Body: ServicesBody,
  },
  {
    id: "harbor",
    title: "Harbor",
    description:
      "A boat for each working agent; flagged boats at the pier need you. Click one to open it.",
    icon: SailboatIcon,
    category: "Ambient",
    sizes: ["m", "l", "w"],
    source: "Thread shells. Drawn once, never animated.",
    bare: true,
    Body: HarborBody,
  },
  {
    id: "pinned",
    title: "Pinned",
    description: "Threads you pinned, one click away.",
    icon: PinIcon,
    category: "Agents",
    sizes: ["s", "m", "t"],
    source: SHELLS,
    count: (data) => ({ n: data.threads.filter((t) => t.pinnedAt !== null).length }),
    Body: PinnedBody,
  },
  {
    id: "snoozed",
    title: "Snoozed",
    description: "Threads you put off, and when each one comes back.",
    icon: MoonIcon,
    category: "Agents",
    sizes: ["s", "m", "t"],
    source: SHELLS,
    Body: SnoozedBody,
  },
  {
    id: "goals",
    title: "Goals",
    description: "Agents working toward a /goal, with tokens and time spent against the budget.",
    icon: TargetIcon,
    category: "Agents",
    sizes: ["m", "l", "t", "w"],
    source: SHELLS,
    count: (data) => ({
      n: data.threads.filter((t) => t.goal !== null && t.goal.status !== "complete").length,
    }),
    Body: GoalsBody,
  },
  {
    id: "background",
    title: "Background work",
    description: "Subagents, monitors and commands agents left running.",
    icon: BotIcon,
    category: "Agents",
    sizes: ["s", "m", "t", "l"],
    source: SHELLS,
    count: (data) => ({ n: data.threads.reduce((n, t) => n + t.background.length, 0) }),
    Body: BackgroundBody,
  },
  {
    id: "scratchpad",
    title: "Scratchpad",
    description: "A note that stays on this device. Send it to the prompt when it's ready.",
    icon: NotebookPenIcon,
    category: "Start",
    sizes: ["s", "m", "t", "l"],
    source: "Saved in this browser only. Nothing leaves the device.",
    Body: ScratchpadBody,
  },
  {
    id: "branches",
    title: "Branches",
    description:
      "Branches and worktrees in this project, with their pull request and latest thread.",
    icon: GitBranchIcon,
    category: "Code",
    sizes: ["m", "l", "t"],
    source: "Thread branches and linked pull requests in this project.",
    Body: BranchesBody,
  },
  {
    id: "today",
    title: "Today",
    description: "Threads started and finished today, and pull requests touched.",
    icon: SunriseIcon,
    category: "Insights",
    sizes: ["s", "m"],
    source: SHELLS,
    Body: TodayBody,
  },
  {
    id: "model-mix",
    title: "Agents this week",
    description: "Which models your threads ran on over the last 7 days.",
    icon: ChartPieIcon,
    category: "Insights",
    sizes: ["s", "m", "t"],
    source: "Model selection on threads from the last 7 days.",
    Body: ModelMixBody,
  },
  {
    id: "projects",
    title: "Projects",
    description:
      "Every project with what's working and waiting in it. Click one to start a thread there.",
    icon: FolderGit2Icon,
    category: "Start",
    sizes: ["s", "m", "t", "l"],
    source: SHELLS,
    Body: ProjectsBody,
  },
  {
    id: "usage-limits",
    title: "Usage limits",
    description: "How much of each plan's session and weekly limit is left, and when it resets.",
    icon: GaugeIcon,
    category: "Machine",
    sizes: ["m", "l", "t", "w"],
    source: "Limits your providers already report in each machine's config. No extra requests.",
    Body: UsageLimitsBody,
  },
  {
    id: "spend-today",
    title: "Spend today",
    description: "What your agents cost today in USD at API prices, split by provider.",
    icon: CoinsIcon,
    category: "Insights",
    sizes: ["s", "m"],
    source:
      "Scans today's transcripts on each machine (a few seconds, cached for a minute). Needs diagnostics access.",
    Body: SpendTodayBody,
  },
  {
    id: "spend-week",
    title: "Spend this week",
    description: "The last 7 days in USD at API prices, day by day and per provider.",
    icon: ChartColumnIcon,
    category: "Insights",
    sizes: ["m", "l", "w"],
    source:
      "Scans the last 7 days of transcripts on each machine (cached for a minute). Needs diagnostics access.",
    Body: SpendWeekBody,
  },
  {
    id: "machines",
    title: "Machines",
    description: "Every machine you're connected to, how it's connected, and its server version.",
    icon: ServerIcon,
    category: "Machine",
    sizes: ["s", "m", "t"],
    source: "Connection state this client already tracks. No extra requests.",
    Body: MachinesBody,
  },
  {
    id: "providers",
    title: "Providers",
    description: "Which agents are ready, which need a sign-in, and which have an update.",
    icon: PlugZapIcon,
    category: "Machine",
    sizes: ["s", "m", "t"],
    source: "Provider status from this machine's config. No extra requests.",
    Body: ProvidersBody,
  },
  {
    id: "automations",
    title: "Automations",
    description: "Scheduled prompts, when each runs next, and a button to run one now.",
    icon: CalendarClockIcon,
    category: "Start",
    sizes: ["m", "l", "t", "w"],
    source:
      "A live subscription to this machine's scheduled tasks, shared with the Automations page.",
    Body: AutomationsBody,
  },
  {
    id: "stash",
    title: "Stashed prompts",
    description: "Prompts you stashed. Click one to put it back in the composer.",
    icon: ArchiveIcon,
    category: "Start",
    sizes: ["s", "m", "t", "l"],
    source: "Your prompt stash, saved in this browser.",
    Body: StashBody,
  },
  {
    id: "skills",
    title: "Skills",
    description: "Skills your agent can use in this project. Click one to add it to the prompt.",
    icon: WandSparklesIcon,
    category: "Start",
    sizes: ["s", "m", "t", "l"],
    source: "The provider's last skill scan for this project. No extra requests.",
    Body: SkillsBody,
  },
  {
    id: "checkout",
    title: "This checkout",
    description: "The branch you'd start on, uncommitted changes, and how far it is from upstream.",
    icon: GitCommitHorizontalIcon,
    category: "Code",
    sizes: ["s", "m", "t", "l"],
    source:
      "A live git status subscription for this checkout, shared with the composer's git controls.",
    Body: CheckoutBody,
  },
  {
    id: "shortcuts",
    title: "Shortcuts",
    description: "Keyboard shortcuts worth knowing, as you have them bound. Small shows one a day.",
    icon: KeyboardIcon,
    category: "Ambient",
    sizes: ["s", "m", "t", "w"],
    source: "Your keybindings, already on this client.",
    Body: ShortcutsBody,
  },
  {
    id: "plans",
    title: "Plans to review",
    description: "Agents in plan mode waiting for you to approve or change their plan.",
    icon: ListChecksIcon,
    category: "Agents",
    sizes: ["s", "m", "t", "l"],
    source: SHELLS,
    count: (data) => {
      const n = data.threads.filter((t) => t.planReady).length;
      return { n, urgent: n > 0 };
    },
    Body: PlansBody,
  },
  {
    id: "catch-up",
    title: "Catch up",
    description: "How many finished threads you haven't opened, and a button for the oldest.",
    icon: InboxIcon,
    category: "Agents",
    sizes: ["s", "m"],
    source: SHELLS,
    Body: CatchUpBody,
  },
  {
    id: "paused",
    title: "Paused on limits",
    description: "Threads that hit a usage limit, and when each one resumes on its own.",
    icon: TimerIcon,
    category: "Agents",
    sizes: ["s", "m", "t"],
    source: SHELLS,
    count: (data) => ({ n: data.threads.filter((t) => t.status === "limited").length }),
    Body: PausedBody,
  },
  {
    id: "quiet",
    title: "Gone quiet",
    description:
      "Threads with an open pull request or worktree that nobody has touched for 3 days.",
    icon: HourglassIcon,
    category: "Code",
    sizes: ["s", "m", "t", "l"],
    source: SHELLS,
    Body: QuietBody,
  },
  {
    id: "shipped",
    title: "Shipped",
    description: "Pull requests your threads merged in the last 7 days.",
    icon: ShipIcon,
    category: "Code",
    sizes: ["s", "m", "t", "l"],
    source: "Pull request links on threads, from their last sync.",
    Body: ShippedBody,
  },
  {
    id: "forecast",
    title: "Forecast",
    description:
      "The weather over your agents: clear when nothing needs you, rain as work piles up, a storm when runs fail.",
    icon: CloudSunIcon,
    category: "Ambient",
    sizes: ["s", "m", "w"],
    source: `${SHELLS} Click the sky to redraw it.`,
    Body: ForecastBody,
  },
  {
    id: "garden",
    title: "Garden",
    description:
      "One plant per day. Height is threads started in this project; a flower means a pull request merged.",
    icon: SproutIcon,
    category: "Ambient",
    sizes: ["s", "m", "l", "w"],
    source: "Thread start times and merged pull requests in this project.",
    Body: GardenBody,
  },
  {
    id: "skyline",
    title: "Skyline",
    description:
      "A building per project, taller with more threads. Lit windows are agents working; click one to start there.",
    icon: Building2Icon,
    category: "Ambient",
    sizes: ["m", "l", "w"],
    source: SHELLS,
    Body: SkylineBody,
  },
  {
    id: "ridgeline",
    title: "Ridgeline",
    description:
      "30 days of thread starts in this project as a mountain range, with the 30 before as the ridge behind.",
    icon: MountainIcon,
    category: "Ambient",
    sizes: ["m", "l", "w"],
    source: "Thread start times in this project, computed on this client.",
    Body: RidgelineBody,
  },
  {
    id: "tide",
    title: "Tide",
    description:
      "Your tightest plan limit as a tide: high water means plenty left, low tide means you're close.",
    icon: WavesIcon,
    category: "Ambient",
    sizes: ["s", "m", "t"],
    source: "Limits your providers already report in each machine's config. No extra requests.",
    Body: TideBody,
  },
  {
    id: "night-sky",
    title: "Night sky",
    description:
      "A star for each turn finished today, grouped into a constellation per project, under tonight's real moon.",
    icon: MoonStarIcon,
    category: "Ambient",
    sizes: ["m", "l", "w"],
    source: SHELLS,
    Body: NightSkyBody,
  },
];

const WIDGETS_BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));

export function resolveWidget(id: string): WidgetDef | undefined {
  const separator = id.indexOf(":");
  if (separator < 0) return WIDGETS_BY_ID.get(id);
  const def = WIDGETS_BY_ID.get(id.slice(0, separator));
  return def?.multiple ? { ...def, id } : undefined;
}

export const titleOf = (def: WidgetDef) => def.titles?.get(def.id) ?? def.title;
