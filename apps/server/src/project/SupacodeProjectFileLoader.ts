/**
 * SupacodeProjectFileLoader - Effect service that loads the checked-in `supacode.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module SupacodeProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { SUPACODE_PROJECT_FILE_NAME, type SupacodeProjectFile } from "@supacode/contracts";
import { SupacodeProjectFileFromJson } from "@supacode/shared/supacodeProjectFile";

const decodeSupacodeProjectFileJson = Schema.decodeEffect(SupacodeProjectFileFromJson);

export class SupacodeProjectFileLoadError extends Schema.TaggedError<SupacodeProjectFileLoadError>()(
  "SupacodeProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${SUPACODE_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for supacode.json project file loading. */
export class SupacodeProjectFileLoader extends Context.Service<
  SupacodeProjectFileLoader,
  {
    /**
     * Load and decode `supacode.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<SupacodeProjectFile>>;
  }
>()("supacode/project/SupacodeProjectFileLoader") {}

const logSupacodeProjectFileLoadError = (error: SupacodeProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: SupacodeProjectFileLoader["Service"]["load"] = Effect.fn(
    "SupacodeProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, SUPACODE_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logSupacodeProjectFileLoadError(
                new SupacodeProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<SupacodeProjectFile>();
    }
    return yield* decodeSupacodeProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logSupacodeProjectFileLoadError(
            new SupacodeProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<SupacodeProjectFile>())),
      }),
    );
  });

  return SupacodeProjectFileLoader.of({ load });
});

export const layer = Layer.effect(SupacodeProjectFileLoader, make);
