import type { TileRequest } from "./protocol";

export const TILE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    root: { type: "string" },
    elements: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          type: { type: "string" },
          props: { type: "object" },
          children: { type: "array", items: { type: "string" } },
        },
        required: ["type"],
      },
    },
  },
  required: ["title", "root", "elements"],
};

const CATALOG = `Components. Use only these, and only the props listed: an unknown prop or a wrong value makes the whole tile fail.
Only Stack, Grid and Section take children. Every element is used exactly once.

Layout
- Stack {direction?: "column"|"row" (default column), gap?: "sm"|"md"|"lg", align?: "start"|"center"|"end"|"stretch"}. In a row, lists and charts get three times the width of counts and text.
- Grid {columns?: 2|3|4}
- Section {title, hint?}: a small muted label above its children.
- Divider {}

Display
- Text {text, tone?, size?: "xs"|"sm"|"md"|"lg"}: words only. Never write a number you guessed.
- Badge {text, tone?}

Live data, computed on the device from the user's real data
- Metric {label, source: "threads"|"pullRequests", where?, warnAbove?: number}: one big count. warnAbove turns it amber when the count is higher.
- Ratio {label, part: Query, whole: Query}: "part of whole" with a bar. Query is {source, where?}.
- Sparkline {label?, where?, field?: "createdAt"|"finishedAt"|"updatedAt", days?: whole number from 7 to 90}: threads per day as bars (default createdAt over 14 days).
- BarList {label?, source, where?, groupBy, limit?}: counts per group as horizontal bars.
    groupBy for threads: "project"|"model"|"status"|"provider"|"repository"
    groupBy for pullRequests: "project"|"status"|"repository"|"checks"
- ThreadList {where?, sort?: "recent"|"oldest"|"created", limit?, empty?: string}: rows open the thread. It shows as many rows as fit.
- PullRequestList {where?, sort?: "recent"|"oldest", limit?, empty?: string}: rows open the pull request.
- UsageGauge {provider?: string}: how much of each plan limit (session, weekly) is left.

Actions
- PromptButton {label, prompt}: writes the prompt into the composer under the tile. Use it for one obvious next step.
- Link {label, href}: https only.

tone is "default"|"muted"|"success"|"warning"|"danger"|"info".

where for threads (every key optional, combined with AND):
  scope: "project" (default: the current project) or "all"
  project: an exact project name from the list below
  status: an array of "needs-you"|"approval"|"input"|"failed"|"limited"|"working"|"waiting"|"ready"
    ("needs-you" means approval, input, failed or limited; "ready" means finished)
  unread: boolean (finished, not opened yet)
  pinned, planReady (a proposed plan waits for approval), hasOpenPr: boolean
  createdWithinDays, updatedWithinDays, updatedOlderThanDays: number
  model, titleIncludes: substring match

where for pullRequests (pull requests linked to threads):
  scope, project: as above
  state: one of "open"|"draft"|"merged"|"closed"
  checks: one of "failing"|"passing"|"pending"
  conflicting, changesRequested: boolean
  updatedWithinDays: number`;

const EXAMPLE = `{"title":"Needs a look","root":"root","elements":{"root":{"type":"Stack","props":{"gap":"md"},"children":["top","list"]},"top":{"type":"Stack","props":{"direction":"row"},"children":["waiting","failing"]},"waiting":{"type":"Metric","props":{"label":"Waiting on you","source":"threads","where":{"scope":"all","status":["needs-you"]},"warnAbove":0}},"failing":{"type":"Metric","props":{"label":"Failing checks","source":"pullRequests","where":{"scope":"all","state":"open","checks":"failing"},"warnAbove":0}},"list":{"type":"ThreadList","props":{"where":{"scope":"all","status":["needs-you"]},"empty":"Nothing needs you right now."}}}}`;

const SIZE_LABEL: Record<TileRequest["size"], string> = {
  s: "small (one column, one row)",
  m: "medium (two columns, one row)",
  t: "tall (one column, two rows)",
  l: "large (two columns, two rows)",
  w: "wide (four columns, one row)",
};

export function buildTilePrompt(request: TileRequest): string {
  const { context } = request;
  const previous =
    request.previous === null
      ? ""
      : `\nThe tile currently looks like this:\n${JSON.stringify(request.previous)}\nChange it as the request says and keep what still fits.\n`;
  return `You design one tile for the new-thread screen of Supacode, an app where a developer runs coding agents in threads. The tile sits in a dashboard grid above the prompt box.

You don't see the user's threads or pull requests, only the project names, model names and counts below. You compose components that query live data on the device, so the tile stays current without you. Do not invent numbers, names or titles.

Reply with one JSON object and nothing else:
{"title": "sentence case, at most 32 characters", "root": "<id>", "elements": {"<id>": {"type": "<Component>", "props": {...}, "children": ["<id>", ...]}}}
Elements are a flat map that reference each other by id.

Space: the tile body is ${Math.round(request.width)}x${Math.round(request.height)}px, ${SIZE_LABEL[request.size]}. A list row is 32px and a Metric is about 56px tall. Prefer one to three components that answer the request well; a crowded tile is worse than a focused one.

${CATALOG}

Example:
${EXAMPLE}

Context:
- Today is ${context.today}.
- Current project: ${context.project ?? "none (all projects)"}.
- Projects: ${context.projects.join(", ") || "none"}.
- Models used recently: ${context.models.join(", ") || "unknown"}.
- Right now: ${context.summary}.
${previous}
Request: ${JSON.stringify(request.prompt)}`;
}
