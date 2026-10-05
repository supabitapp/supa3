/**
 * Pure parsing and classification for checkpoint attribution. GitVcsDriver runs
 * the Git commands; this module reads their output.
 *
 * A checkpoint commit records the HEAD it was captured on. When HEAD differs
 * between two checkpoints, a path counts as moved by Git only when its exact
 * (mode, blob) transition between the checkpoints equals its transition between
 * the two HEADs and no commit made during the turn touched it. Every other path
 * stays with the turn.
 */
import type {
  VcsCheckpointChangeAttribution,
  VcsCheckpointFileChange,
  VcsCheckpointHead,
} from "./VcsDriver.ts";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Builds the checkpoint commit subject. Ref names never contain spaces. */
export function formatCheckpointMessage(
  checkpointRef: string,
  head: VcsCheckpointHead | null,
): string {
  const headFields =
    head === null
      ? ""
      : ` head=${head.commit}${head.branch === null ? "" : ` branch=${head.branch}`}`;
  return `supacode checkpoint ref=${checkpointRef}${headFields}`;
}

/** Reads `git rev-parse HEAD^{commit} --symbolic-full-name HEAD --` output. */
export function parseRevParseHead(stdout: string): VcsCheckpointHead | null {
  const [commit, symbolicName] = stdout.split("\n");
  if (commit === undefined || !OBJECT_ID.test(commit)) return null;
  return {
    commit,
    branch: symbolicName?.startsWith("refs/") === true ? symbolicName : null,
  };
}

function parseCheckpointHead(subject: string): VcsCheckpointHead | null {
  const fields = new Map(
    subject.split(" ").flatMap((field) => {
      const separator = field.indexOf("=");
      return separator > 0
        ? [[field.slice(0, separator), field.slice(separator + 1)] as const]
        : [];
    }),
  );
  const commit = fields.get("head");
  if (commit === undefined || !OBJECT_ID.test(commit)) return null;
  return { commit, branch: fields.get("branch") ?? null };
}

/**
 * Reads `git for-each-ref --format=%(refname)%00%(objecttype)%00%(subject)%00`
 * output into the HEAD each commit ref recorded.
 */
export function parseCheckpointHeadRecords(stdout: string): Map<string, VcsCheckpointHead | null> {
  const heads = new Map<string, VcsCheckpointHead | null>();
  for (const record of stdout.split("\0\n")) {
    const [refName, objectType, subject] = record.split("\0");
    if (refName === undefined || objectType !== "commit") continue;
    heads.set(refName, parseCheckpointHead(subject ?? ""));
  }
  return heads;
}

interface RawChange {
  /** `oldMode newMode oldOid newOid`, comparable across diffs of full object ids. */
  readonly transition: string;
}

interface TreeChange extends RawChange {
  readonly additions: number;
  readonly deletions: number;
}

const RAW_HEADER =
  /^:\d{6} \d{6} [0-9a-f]{40}(?:[0-9a-f]{24})? [0-9a-f]{40}(?:[0-9a-f]{24})? [ADMT]$/;

/**
 * Reads NUL-delimited `--raw` records, followed by one `--numstat` record per
 * change when `withNumstat` is set, from a diff without rename detection.
 * Returns undefined for output it cannot fully account for, since a change
 * dropped here would vanish from the turn instead of being listed. That
 * includes paths that are not valid UTF-8: decoded with U+FFFD they no longer
 * name the file, so a diff limited to them could not find it.
 */
export function parseRawDiff(
  stdout: string,
  withNumstat: boolean,
): Map<string, TreeChange> | undefined {
  if (stdout === "") return new Map();
  if (!stdout.endsWith("\0")) return undefined;
  const records = stdout.slice(0, -1).split("\0");
  const changes = new Map<string, TreeChange>();
  let index = 0;
  // A raw header always precedes its path, so a path starting with ":" is safe.
  while (records[index]?.startsWith(":") === true) {
    const header = records[index]!;
    const path = records[index + 1];
    if (!RAW_HEADER.test(header) || !path || path.includes("\uFFFD") || changes.has(path)) {
      return undefined;
    }
    changes.set(path, {
      transition: header.slice(1, header.lastIndexOf(" ")),
      additions: 0,
      deletions: 0,
    });
    index += 2;
  }
  if (records.length - index !== (withNumstat ? changes.size : 0)) return undefined;
  for (; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) return undefined;
    const path = record.slice(counts[0].length);
    const change = changes.get(path);
    if (change === undefined) return undefined;
    changes.set(path, {
      ...change,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }
  return changes;
}

/**
 * Reads `git rev-list --timestamp --parents` output into the commits made at or
 * after `sinceSeconds`. Returns undefined when one of them is an octopus merge,
 * which `--remerge-diff` skips, so its hand edits could not be seen.
 */
export function selectTurnCommits(
  stdout: string,
  sinceSeconds: number,
): ReadonlyArray<string> | undefined {
  const commits: string[] = [];
  for (const line of stdout.split("\n")) {
    const [timestamp, commit, ...parents] = line.split(" ");
    if (commit === undefined || Number(timestamp) < sinceSeconds) continue;
    if (parents.length > 2) return undefined;
    commits.push(commit);
  }
  return commits;
}

export function attributeCheckpointChanges(input: {
  readonly tree: ReadonlyMap<string, TreeChange>;
  readonly head: ReadonlyMap<string, RawChange>;
  readonly turnPaths: ReadonlySet<string>;
}): VcsCheckpointChangeAttribution {
  const files: VcsCheckpointFileChange[] = [];
  const gitMoved = { fileCount: 0, additions: 0, deletions: 0 };
  for (const [path, change] of input.tree) {
    const moved =
      input.head.get(path)?.transition === change.transition && !input.turnPaths.has(path);
    if (moved) {
      gitMoved.fileCount += 1;
      gitMoved.additions += change.additions;
      gitMoved.deletions += change.deletions;
    } else {
      files.push({ path, additions: change.additions, deletions: change.deletions });
    }
  }
  return {
    files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    gitMoved,
  };
}
