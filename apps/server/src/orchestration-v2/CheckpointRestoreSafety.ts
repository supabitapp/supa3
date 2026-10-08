import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

// A checkpoint snapshots the whole checkout. Check at command admission and
// again before provider rollback so a newly shared worktree is rejected too.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
      readonly projects: ProjectStore.ProjectStoreV2["Service"];
      readonly path: Path.Path;
    },
  ) {
    const { fileSystem, projections, projects, path } = dependencies;
    const canonicalPath = Effect.fnUntraced(function* (
      candidate: string,
    ): Effect.fn.Return<string, PlatformError> {
      const absolute = path.resolve(candidate);
      return yield* fileSystem.realPath(absolute).pipe(
        Effect.catch((error) => {
          const parent = path.dirname(absolute);
          return error.reason._tag === "NotFound" && parent !== absolute
            ? canonicalPath(parent).pipe(
                Effect.map((root) => path.join(root, path.basename(absolute))),
              )
            : Effect.fail(error);
        }),
      );
    });
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const worktreePath = thread.worktreePath;
    let shared = worktreePath == null;
    if (!shared && worktreePath !== null) {
      const cwd = yield* canonicalPath(scope.cwd);
      const worktreeCwd = yield* canonicalPath(worktreePath);
      shared = cwd !== worktreeCwd;
      if (!shared) {
        const shell = yield* projections.getShellSnapshot();
        const checkedPaths = new Set<string>();
        for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
          if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
          const other = yield* projections.getCheckpointContext(otherThread.id);
          const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
          const paths = [
            otherThread.worktreePath,
            ...other.checkpointScopes.map((candidate) => candidate.cwd),
            // A failed turn can leave an errored session with a live event stream.
            // A session shared across threads keeps the cwd it was opened with,
            // often another thread's; each turn runs in the thread's own
            // worktree or project root, which this list already covers.
            ...providerContext.providerSessions
              .filter(
                (session) =>
                  session.status !== "stopped" &&
                  !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
              )
              .map((session) => session.cwd),
          ].filter((value): value is string => value !== null);
          if (otherThread.worktreePath === null) {
            // A thread without a worktree works in its project's checkout.
            const project = yield* projects.get(otherThread.projectId, { includeDeleted: true });
            if (Option.isNone(project)) return false;
            paths.push(project.value.workspaceRoot);
          }
          for (const candidate of paths) {
            if (checkedPaths.has(candidate)) continue;
            checkedPaths.add(candidate);
            const otherCwd = yield* canonicalPath(candidate);
            if (contains(cwd, otherCwd) || contains(otherCwd, cwd)) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
      }
    }
    return !shared;
  },
);
