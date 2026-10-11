import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Tone = Schema.Literals(["default", "muted", "success", "warning", "danger", "info"]);
const Scope = {
  scope: Schema.optional(Schema.Literals(["project", "all"])),
  project: Schema.optional(Schema.String),
};

const ThreadWhere = Schema.Struct({
  ...Scope,
  status: Schema.optional(
    Schema.Array(
      Schema.Literals([
        "needs-you",
        "approval",
        "input",
        "failed",
        "limited",
        "working",
        "waiting",
        "ready",
      ]),
    ),
  ),
  unread: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
  planReady: Schema.optional(Schema.Boolean),
  hasOpenPr: Schema.optional(Schema.Boolean),
  createdWithinDays: Schema.optional(Schema.Number),
  updatedWithinDays: Schema.optional(Schema.Number),
  updatedOlderThanDays: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  titleIncludes: Schema.optional(Schema.String),
});

const PrWhere = Schema.Struct({
  ...Scope,
  state: Schema.optional(Schema.Literals(["open", "draft", "merged", "closed"])),
  checks: Schema.optional(Schema.Literals(["failing", "passing", "pending"])),
  conflicting: Schema.optional(Schema.Boolean),
  changesRequested: Schema.optional(Schema.Boolean),
  updatedWithinDays: Schema.optional(Schema.Number),
});

const ThreadQuery = Schema.Struct({
  source: Schema.Literal("threads"),
  where: Schema.optional(ThreadWhere),
});
const PrQuery = Schema.Struct({
  source: Schema.Literal("pullRequests"),
  where: Schema.optional(PrWhere),
});
const Query = Schema.Union([ThreadQuery, PrQuery]);

const MetricFields = { label: Schema.String, warnAbove: Schema.optional(Schema.Number) };
const BarListFields = {
  label: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
};

const PROPS = {
  Stack: Schema.Struct({
    direction: Schema.optional(Schema.Literals(["row", "column"])),
    gap: Schema.optional(Schema.Literals(["sm", "md", "lg"])),
    align: Schema.optional(Schema.Literals(["start", "center", "end", "stretch"])),
  }),
  Grid: Schema.Struct({ columns: Schema.optional(Schema.Literals([2, 3, 4])) }),
  Section: Schema.Struct({ title: Schema.String, hint: Schema.optional(Schema.String) }),
  Divider: Schema.Struct({}),
  Text: Schema.Struct({
    text: Schema.String,
    tone: Schema.optional(Tone),
    size: Schema.optional(Schema.Literals(["xs", "sm", "md", "lg"])),
  }),
  Badge: Schema.Struct({ text: Schema.String, tone: Schema.optional(Tone) }),
  Metric: Schema.Union([
    Schema.Struct({ ...ThreadQuery.fields, ...MetricFields }),
    Schema.Struct({ ...PrQuery.fields, ...MetricFields }),
  ]),
  Ratio: Schema.Struct({ label: Schema.String, part: Query, whole: Query }),
  Sparkline: Schema.Struct({
    label: Schema.optional(Schema.String),
    where: Schema.optional(ThreadWhere),
    field: Schema.optional(Schema.Literals(["createdAt", "finishedAt", "updatedAt"])),
    days: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 7, maximum: 90 }))),
  }),
  BarList: Schema.Union([
    Schema.Struct({
      ...ThreadQuery.fields,
      ...BarListFields,
      groupBy: Schema.Literals(["project", "model", "status", "provider", "repository"]),
    }),
    Schema.Struct({
      ...PrQuery.fields,
      ...BarListFields,
      groupBy: Schema.Literals(["project", "status", "repository", "checks"]),
    }),
  ]),
  ThreadList: Schema.Struct({
    where: Schema.optional(ThreadWhere),
    sort: Schema.optional(Schema.Literals(["recent", "oldest", "created"])),
    limit: Schema.optional(Schema.Number),
    empty: Schema.optional(Schema.String),
  }),
  PullRequestList: Schema.Struct({
    where: Schema.optional(PrWhere),
    sort: Schema.optional(Schema.Literals(["recent", "oldest"])),
    limit: Schema.optional(Schema.Number),
    empty: Schema.optional(Schema.String),
  }),
  UsageGauge: Schema.Struct({ provider: Schema.optional(Schema.String) }),
  PromptButton: Schema.Struct({ label: Schema.String, prompt: Schema.String }),
  Link: Schema.Struct({ label: Schema.String, href: Schema.String }),
};

type TileType = keyof typeof PROPS;
export type TileProps<K extends TileType> = (typeof PROPS)[K]["Type"];
export type TileTone = typeof Tone.Type;
export type TileQuery = typeof Query.Type;
export type ThreadFilter = typeof ThreadWhere.Type;
export type PrFilter = typeof PrWhere.Type;

export type TileElement = {
  [K in TileType]: {
    readonly type: K;
    readonly props: TileProps<K>;
    readonly children: ReadonlyArray<string>;
  };
}[TileType];

export interface TileSpec {
  readonly title: string;
  readonly root: string;
  readonly elements: ReadonlyMap<string, TileElement>;
}

const LAYOUT: ReadonlySet<TileType> = new Set(["Stack", "Grid", "Section"]);
const MAX_ELEMENTS = 40;
const MAX_DEPTH = 6;
const STRICT = { onExcessProperty: "error" } as const;

const RawSpec = Schema.Struct({
  title: Schema.String,
  root: Schema.String,
  elements: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.String,
      props: Schema.optional(Schema.Unknown),
      children: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const decodeRawSpec = Schema.decodeUnknownOption(RawSpec);
const isTileType = (type: string): type is TileType => Object.hasOwn(PROPS, type);

function decodeElement(type: TileType, props: unknown, children: ReadonlyArray<string>) {
  const schema: Schema.ConstraintDecoder<unknown> = PROPS[type];
  return Option.map(
    Schema.decodeOption(schema)(props ?? {}, STRICT),
    (decoded) => ({ type, props: decoded, children }) as TileElement,
  );
}

function checkTree(spec: TileSpec): string | null {
  const seen = new Set<string>();
  const visit = (id: string, depth: number): string | null => {
    const element = spec.elements.get(id);
    if (!element) return `it points at "${id}", which isn't defined`;
    if (seen.has(id)) return `"${id}" is used more than once`;
    if (depth > MAX_DEPTH) return "it is nested too deeply";
    seen.add(id);
    if (seen.size > MAX_ELEMENTS) return "it has too many parts";
    if (element.children.length > 0 && !LAYOUT.has(element.type))
      return `${element.type} can't hold other parts`;
    for (const child of element.children) {
      const problem = visit(child, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return visit(spec.root, 0);
}

export type DecodedTile = { ok: true; spec: TileSpec } | { ok: false; reason: string };

export function decodeTileSpec(input: unknown): DecodedTile {
  const raw = decodeRawSpec(input);
  if (Option.isNone(raw)) return { ok: false, reason: "it isn't a tile" };
  const elements = new Map<string, TileElement>();
  for (const [id, element] of Object.entries(raw.value.elements)) {
    if (!isTileType(element.type))
      return { ok: false, reason: `it uses "${element.type}", which isn't a tile component` };
    const decoded = decodeElement(element.type, element.props, element.children ?? []);
    if (Option.isNone(decoded))
      return { ok: false, reason: `${element.type} "${id}" has props it doesn't support` };
    elements.set(id, decoded.value);
  }
  const spec = { title: raw.value.title.slice(0, 32), root: raw.value.root, elements };
  const problem = checkTree(spec);
  return problem ? { ok: false, reason: problem } : { ok: true, spec };
}
