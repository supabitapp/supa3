import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(supacodeHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(supacodeHome)) {
    return Option.none();
  }
  const trimmed = supacodeHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly supacodeHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.supacodeHome), () =>
    input.joinPath(input.homeDirectory, ".supacode"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly supacodeHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.supacodeHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
