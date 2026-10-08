import type { DesktopCliCommandState } from "@supacode/contracts";
import { HostProcessPlatform } from "@supacode/shared/hostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@supacode/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

const unixCandidates = (home: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`]
    : [`${home}/.local/bin`, `${home}/bin`];

const pathEntries = (value: string | undefined, separator: string) =>
  (value ?? "").split(separator).filter((entry) => entry.length > 0);

const sameWindowsPath = (left: string, right: string) =>
  left.trim().replace(/^"|"$/g, "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() ===
  right.trim().replace(/^"|"$/g, "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

const WindowsPathEnvironment = Schema.Struct({
  userPath: Schema.String,
  path: Schema.String,
  pathExt: Schema.String,
});

const WINDOWS_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($env:SUPACODE_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue('Path', $env:SUPACODE_PATH, $kind)
  Add-Type -Namespace Supacode -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $result = [System.UIntPtr]::Zero
  [void][Supacode.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $extensions = [Environment]::GetEnvironmentVariable('PATHEXT', 'User')
  if ([string]::IsNullOrEmpty($extensions)) { $extensions = [Environment]::GetEnvironmentVariable('PATHEXT', 'Machine') }
  if ([string]::IsNullOrEmpty($extensions)) { $extensions = $env:PATHEXT }
  $snapshot = @{
    userPath = [string]$value
    path = [Environment]::ExpandEnvironmentVariables("$machinePath;$value")
    pathExt = [string]$extensions
  } | ConvertTo-Json -Compress
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($snapshot)))
}
`;

export class DesktopCliCommand extends Context.Service<
  DesktopCliCommand,
  {
    readonly state: Effect.Effect<DesktopCliCommandState>;
    readonly install: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstall: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
  }
>()("@supacode/desktop/app/DesktopCliCommand") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const launcher = DesktopCliShim.launcherPath(environment);
  const binDirectory = path.dirname(launcher);

  const markerName = "cli-command-path-entry";
  const ownedPathMarker = path.join(environment.appDataDirectory, "Supacode", markerName);

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const isOurLink = (link: string) =>
    Effect.gen(function* () {
      yield* fs.readLink(link);

      const info = yield* fs.stat(link);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      const content = yield* fs.readFileString(link);
      return content.includes(DesktopCliShim.MARKER);
    }).pipe(Effect.orElseSucceed(() => false));

  const powershell = (env: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = process.env.SystemRoot ?? process.env.WINDIR;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
            { stdin: "ignore", stderr: "ignore", env, extendEnv: true },
          ),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return yield* Effect.fail(`powershell exited with ${exitCode}`);
        return stdout;
      }),
    );
  const readWindowsPath = powershell({}).pipe(
    Effect.map((encoded) => Buffer.from(encoded.trim(), "base64").toString("utf8")),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WindowsPathEnvironment))),
    Effect.mapError(() => fail("Could not read your PATH, so it was left unchanged.")),
  );
  const writeUserPath = (value: string) =>
    powershell({ SUPACODE_SET: "1", SUPACODE_PATH: value }).pipe(
      Effect.asVoid,
      Effect.mapError(() => fail("Could not update your PATH.")),
    );

  const readWindowsOwnership = Effect.fnUntraced(function* (entries: ReadonlyArray<string>) {
    const markers = new Set([
      ownedPathMarker,
      path.join(environment.stateDir, markerName),
      ...entries.map((entry) =>
        path.join(path.dirname(entry.trim().replace(/^"|"$/g, "")), "userdata", markerName),
      ),
    ]);
    const directories: string[] = [];
    const existingMarkers: string[] = [];
    for (const marker of markers) {
      const recorded = yield* fs.readFileString(marker).pipe(Effect.option);
      if (Option.isNone(recorded)) continue;
      existingMarkers.push(marker);
      for (const directory of recorded.value.split(/\r?\n/).filter((entry) => entry.length > 0)) {
        if (!directories.some((entry) => sameWindowsPath(entry, directory))) {
          directories.push(directory);
        }
      }
    }
    return { directories, markers: existingMarkers };
  });

  const writeWindowsOwnership = Effect.fnUntraced(
    function* (directories: ReadonlyArray<string>) {
      if (directories.length === 0) {
        yield* fs.remove(ownedPathMarker, { force: true });
        return;
      }
      yield* fs.makeDirectory(path.dirname(ownedPathMarker), { recursive: true });
      const staging = `${ownedPathMarker}.${process.pid}.tmp`;
      yield* fs.writeFileString(staging, `${directories.join("\n")}\n`);
      yield* fs.rename(staging, ownedPathMarker);
    },
    Effect.mapError(() => fail("Could not record the supacode PATH entry.")),
  );

  const removeLegacyMarkers = Effect.fnUntraced(function* (markers: ReadonlyArray<string>) {
    for (const marker of markers) {
      if (!sameWindowsPath(marker, ownedPathMarker)) yield* fs.remove(marker).pipe(Effect.ignore);
    }
  });

  const firstOnPath = Effect.gen(function* () {
    for (const directory of pathEntries(process.env.PATH, ":")) {
      const candidate = path.join(directory, "supacode");
      if (yield* exists(candidate)) return Option.some(candidate);
    }
    return Option.none<string>();
  });

  const installedAt = Effect.gen(function* () {
    for (const directory of unixCandidates(environment.homeDirectory, environment.platform)) {
      const link = path.join(directory, "supacode");
      if (yield* isOurLink(link)) return Option.some(link);
    }
    return Option.none<string>();
  });

  const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
    if (!environment.isPackaged) {
      return { supported: false, installedPath: null, onPath: false } as const;
    }
    if (windows) {
      const snapshot = yield* readWindowsPath;
      const entries = pathEntries(snapshot.userPath, ";");
      const owned = yield* readWindowsOwnership(entries);
      if (
        !owned.directories.some((entry) => sameWindowsPath(entry, binDirectory)) ||
        !entries.some((entry) => sameWindowsPath(entry, binDirectory))
      ) {
        return { supported: true, installedPath: null, onPath: false };
      }
      const first = yield* resolveCommandPath("supacode", {
        env: { PATH: snapshot.path, PATHEXT: snapshot.pathExt },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.option,
      );
      return {
        supported: true,
        installedPath: launcher,
        onPath: Option.isSome(first) && sameWindowsPath(first.value, launcher),
      };
    }
    const installed = yield* installedAt;
    if (Option.isNone(installed)) return { supported: true, installedPath: null, onPath: false };

    const first = yield* firstOnPath;
    const onPath = Option.isSome(first) && (yield* isOurLink(first.value));
    return { supported: true, installedPath: installed.value, onPath };
  }).pipe(Effect.orElseSucceed(() => ({ supported: false, installedPath: null, onPath: false })));

  const ensureLauncher = DesktopCliShim.install.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(fail(`Could not set up the supacode launcher at ${launcher}.`)),
        onSome: () => Effect.void,
      }),
    ),
  );

  const install: DesktopCliCommand["Service"]["install"] = Effect.gen(function* () {
    if (!environment.isPackaged) return yield* fail("The supacode command needs an installed app.");
    yield* ensureLauncher;
    if (windows) {
      const snapshot = yield* readWindowsPath;
      const entries = pathEntries(snapshot.userPath, ";");
      const owned = yield* readWindowsOwnership(entries);
      const kept = entries.filter(
        (entry) =>
          sameWindowsPath(entry, binDirectory) ||
          !owned.directories.some((directory) => sameWindowsPath(entry, directory)),
      );
      const added = !kept.some((entry) => sameWindowsPath(entry, binDirectory));
      const changed = added || kept.length !== entries.length;
      if (changed) yield* writeUserPath([...kept, ...(added ? [binDirectory] : [])].join(";"));
      const ownsCurrent =
        added || owned.directories.some((entry) => sameWindowsPath(entry, binDirectory));
      yield* writeWindowsOwnership(ownsCurrent ? [binDirectory] : []).pipe(
        Effect.tapError(() => (changed ? writeUserPath(snapshot.userPath) : Effect.void)),
      );
      yield* removeLegacyMarkers(owned.markers);
      return yield* state;
    }
    const existing = yield* installedAt;
    if (Option.isSome(existing)) {
      const target = yield* fs.readLink(existing.value).pipe(Effect.option);
      if (Option.getOrUndefined(target) === launcher) return yield* state;

      yield* fs
        .remove(existing.value)
        .pipe(Effect.mapError(() => fail(`Could not replace ${existing.value}.`)));
    }
    const onPath = pathEntries(process.env.PATH, ":");
    const candidates = unixCandidates(environment.homeDirectory, environment.platform);

    for (const directory of [
      ...candidates.filter((candidate) => onPath.includes(candidate)),
      ...candidates.filter((candidate) => !onPath.includes(candidate)),
    ]) {
      const link = path.join(directory, "supacode");
      const created = (yield* exists(directory))
        ? yield* writableDirectory(directory)
        : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!created) continue;

      const linked = yield* fs.symlink(launcher, link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) return yield* state;
    }
    return yield* fail(
      `Another supacode command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
    );
  }).pipe(Effect.withSpan("desktop.cliCommand.install"));

  const uninstall: DesktopCliCommand["Service"]["uninstall"] = Effect.gen(function* () {
    if (windows) {
      const snapshot = yield* readWindowsPath;
      const entries = pathEntries(snapshot.userPath, ";");
      const owned = yield* readWindowsOwnership(entries);
      const kept = entries.filter(
        (entry) => !owned.directories.some((directory) => sameWindowsPath(entry, directory)),
      );
      const changed = kept.length !== entries.length;
      if (changed) yield* writeUserPath(kept.join(";"));
      yield* writeWindowsOwnership([]).pipe(
        Effect.tapError(() => (changed ? writeUserPath(snapshot.userPath) : Effect.void)),
      );
      yield* removeLegacyMarkers(owned.markers);
      return yield* state;
    }
    for (const directory of unixCandidates(environment.homeDirectory, environment.platform)) {
      const link = path.join(directory, "supacode");
      if (yield* isOurLink(link)) {
        yield* fs.remove(link).pipe(Effect.mapError(() => fail(`Could not remove ${link}.`)));
      }
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

  return DesktopCliCommand.of({ state, install, uninstall });
});

export const layer = Layer.effect(DesktopCliCommand, make);
