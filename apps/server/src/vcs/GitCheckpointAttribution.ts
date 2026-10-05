import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as Effect from "effect/Effect";
import type { VcsCheckpointGitUpdate, VcsCheckpointGitUpdateInput } from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const MAX_COMMITS = 512;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Missing or malformed metadata keeps legacy checkpoints on the full-diff path. */
function readHead(message: string) {
  const match =
    /^supacode checkpoint ref=\S+ head=([a-f0-9]{40}|[a-f0-9]{64})(?: branch=(refs\/heads\/\S+))?\n*$/.exec(
      message,
    );
  return match ? { head: match[1]!, branch: match[2] ?? null } : undefined;
}

/** --raw --no-abbrev --no-renames -z encodes a header and a literal path per change. */
function readTransitions(raw: string) {
  if (raw === "") return new Map<string, string>();
  if (!raw.endsWith("\0")) return undefined;
  const records = raw.slice(0, -1).split("\0");
  if (records.length % 2 !== 0) return undefined;
  const transitions = new Map<string, string>();
  for (let index = 0; index < records.length; index += 2) {
    const header = /^:(\d{6} \d{6} [a-f0-9]{40,64} [a-f0-9]{40,64}) [AMDT]$/.exec(records[index]!);
    const path = records[index + 1]!;
    if (!header || path.length === 0 || transitions.has(path)) return undefined;
    transitions.set(path, header[1]!);
  }
  return transitions;
}

/** Only exact HEAD transitions untouched by recent commits can be grouped as Git updates. */
export const getCheckpointGitUpdate = Effect.fn("GitVcsDriver.checkpoints.getCheckpointGitUpdate")(
  function* (input: VcsCheckpointGitUpdateInput) {
    const process = yield* VcsProcess.VcsProcess;
    const run = (args: ReadonlyArray<string>, stdin?: string) =>
      process.run({
        operation: "GitVcsDriver.checkpoints.getCheckpointGitUpdate",
        command: "git",
        cwd: input.cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "error",
        timeoutMs: TIMEOUT_MS,
      });
    const metadata = yield* run([
      "log",
      "--no-walk=unsorted",
      "--format=%B%x00",
      `${input.fromCheckpointRef}^{commit}`,
      `${input.toCheckpointRef}^{commit}`,
      "--",
    ]);
    if (metadata.stdoutInvalidUtf8) return undefined;
    const messages = metadata.stdout.split("\0");
    if (messages.length !== 3 || messages[2]?.trim() !== "") return undefined;
    const from = readHead(messages[0]!.trim());
    const to = readHead(messages[1]!.trim());
    if (!from || !to || from.head === to.head) return undefined;
    if (!Number.isFinite(input.runStartedAtMs)) return undefined;

    // Do not use --since: it can stop traversal at an old-dated commit and miss
    // newer committer dates behind it. The extra record detects a bounded walk.
    const history = yield* run([
      "log",
      "--format=%H %ct",
      `--max-count=${MAX_COMMITS + 1}`,
      `${from.head}..${to.head}`,
      "--",
    ]);
    if (history.stdoutInvalidUtf8) return undefined;
    const commits = history.stdout.trim() === "" ? [] : history.stdout.trim().split("\n");
    if (commits.length > MAX_COMMITS) return undefined;
    const recentCommits: string[] = [];
    const startedAt = Math.floor(input.runStartedAtMs / 1000);
    for (const commit of commits) {
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (\d+)$/.exec(commit);
      if (!match) return undefined;
      if (Number(match[2]) >= startedAt) recentCommits.push(match[1]!);
    }
    const touched = new Set<string>();
    if (recentCommits.length > 0) {
      // Combined merge diffs list only paths changed from every parent; taking
      // the first-parent diff would incorrectly claim the imported branch.
      const changes = yield* run(
        [
          "diff-tree",
          "--stdin",
          "--root",
          "--no-commit-id",
          "-r",
          "--cc",
          "--name-only",
          "--no-renames",
          "--no-relative",
          "--no-ext-diff",
          "--no-textconv",
          "-z",
        ],
        recentCommits.join("\n") + "\n",
      );
      if (changes.stdoutInvalidUtf8 || (changes.stdout !== "" && !changes.stdout.endsWith("\0")))
        return undefined;
      for (const path of changes.stdout.split("\0")) {
        if (path) touched.add(path);
      }
    }
    const diffArgs = [
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-relative",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
    ];
    const treeOutput = yield* run([
      ...diffArgs,
      input.fromCheckpointRef,
      input.toCheckpointRef,
      "--",
    ]);
    const headOutput = yield* run([...diffArgs, from.head, to.head, "--"]);
    if (treeOutput.stdoutInvalidUtf8 || headOutput.stdoutInvalidUtf8) return undefined;
    const trees = readTransitions(treeOutput.stdout);
    const heads = readTransitions(headOutput.stdout);
    if (!trees || !heads) return undefined;
    const numstat = yield* run([
      "diff",
      "--numstat",
      "--no-renames",
      "--no-relative",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      input.fromCheckpointRef,
      input.toCheckpointRef,
      "--",
    ]);
    if (numstat.stdoutInvalidUtf8) return undefined;
    const files = parseTurnDiffFilesFromNumstat(numstat.stdout).map((file) => ({
      ...file,
      kind: "modified",
    }));
    if (trees.size !== files.length) return undefined;
    const paths = new Set<string>();
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      const transition = trees.get(file.path);
      if (transition === undefined) return undefined;
      if (transition === heads.get(file.path) && !touched.has(file.path)) {
        paths.add(file.path);
        additions += file.additions;
        deletions += file.deletions;
      }
    }
    if (paths.size === 0) return undefined;
    return {
      files: files.filter((file) => !paths.has(file.path)),
      summary: {
        fromHead: from.head,
        toHead: to.head,
        fromBranch: from.branch,
        toBranch: to.branch,
        fileCount: paths.size,
        additions,
        deletions,
      },
    } satisfies VcsCheckpointGitUpdate;
  },
  // The budget includes queued process admission and all history/diff commands.
  Effect.timeoutOption(TIMEOUT_MS),
  Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
  Effect.orElseSucceed(() => undefined),
);
