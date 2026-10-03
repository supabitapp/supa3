// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function resolveDefaultSupacodeHome(
  homeDirectory: string,
  joinPath: (first: string, ...segments: string[]) => string = NodePath.join,
  pathExists: (path: string) => boolean = NodeFS.existsSync,
): string {
  const home = joinPath(homeDirectory, ".supacode");
  const legacyHome = joinPath(homeDirectory, ".supa3");
  return !pathExists(home) && pathExists(legacyHome) ? legacyHome : home;
}
