import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const environmentFor = (
  path: Path.Path,
  input: { home: string; baseDir: string; platform?: NodeJS.Platform; isPackaged?: boolean },
) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: input.platform ?? "linux",
    isPackaged: input.isPackaged ?? true,
    homeDirectory: input.home,
    appDataDirectory: path.join(input.home, "AppData", "Roaming"),
    baseDir: input.baseDir,
    stateDir: path.join(input.baseDir, "userdata"),
    serverRoot: "/opt/Supacode/resources/app.asar",
    appImagePath: Option.none(),
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const commandIn = (
  input: { home: string; baseDir?: string; platform?: NodeJS.Platform; isPackaged?: boolean },
  spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const baseDir = input.baseDir ?? path.join(input.home, ".supacode");
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const make = DesktopCliCommand.make.pipe(
      Effect.provideService(
        DesktopEnvironment.DesktopEnvironment,
        environmentFor(path, { ...input, baseDir }),
      ),
    );
    return yield* spawner
      ? make.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      : make;
  });

const fakePowerShell = (initial: string, machinePath = "") => {
  const registry = {
    path: initial,
    machinePath,
    pathExt: ".COM;.EXE;.BAT;.CMD",
    failReads: false,
    writes: 0,
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { options } = command as unknown as {
        readonly options: { readonly env?: Record<string, string> };
      };
      const env = options.env ?? {};
      let exitCode = 0;
      let stdout = "";
      if (env.SUPACODE_SET === "1") {
        registry.path = env.SUPACODE_PATH ?? "";
        registry.writes += 1;
      } else if (registry.failReads) {
        exitCode = 1;
      } else {
        stdout = Buffer.from(
          JSON.stringify({
            userPath: registry.path,
            path: [registry.machinePath, registry.path].filter(Boolean).join(";"),
            pathExt: registry.pathExt,
          }),
          "utf8",
        ).toString("base64");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { registry, spawner };
};

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  it.effect("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const link = path.join(home, ".local", "bin", "supacode");

      expect(yield* command.state).toEqual({ supported: true, installedPath: null, onPath: false });

      const installed = yield* command.install;
      expect(installed.installedPath).toBe(link);
      expect(yield* fs.readLink(link)).toBe(path.join(home, ".supacode", "bin", "supacode"));
      expect((yield* command.install).installedPath).toBe(link);

      expect((yield* command.uninstall).installedPath).toBeNull();
      expect(yield* fs.exists(link)).toBe(false);

      expect(yield* fs.exists(path.join(home, ".supacode", "bin", "supacode"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("never replaces or removes a supacode it did not create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const theirs = path.join(home, ".local", "bin", "supacode");
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.writeFileString(theirs, "npm's supacode\n");

      yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "supacode"));

      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("Another supacode command is already installed");
      yield* command.uninstall;
      expect(yield* fs.readFileString(theirs)).toBe("npm's supacode\n");
      expect(yield* fs.readLink(path.join(home, "bin", "supacode"))).toBe(path.join(home, "gone"));
    }).pipe(Effect.scoped),
  );

  it.effect("finds and removes a link left by a previous Supacode home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const before = yield* commandIn({ home, baseDir: path.join(home, "old-supacode") });
      const link = (yield* before.install).installedPath;

      const after = yield* commandIn({ home, baseDir: path.join(home, "new-supacode") });
      expect((yield* after.state).installedPath).toBe(link);

      expect((yield* after.install).installedPath).toBe(link);
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-supacode", "bin", "supacode"));
      yield* after.uninstall;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "supacode"))).toBe(false);
      expect(yield* fs.exists(path.join(home, "bin", "supacode"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not read a large binary another supacode links to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();

      const binary = path.join(home, "native-supacode");
      yield* fs.writeFileString(binary, `${"\0".repeat(64 * 1024)}${DesktopCliShim.MARKER}`);
      yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
      yield* fs.symlink(binary, path.join(home, ".local", "bin", "supacode"));
      const command = yield* commandIn({ home });
      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(yield* fs.readLink(path.join(home, ".local", "bin", "supacode"))).toBe(binary);
    }).pipe(Effect.scoped),
  );

  it.effect("reports when another supacode earlier on PATH would run instead", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.writeFileString(path.join(shadow, "supacode"), "#!/bin/sh\n", { mode: 0o755 });
      const previous = process.env.PATH;
      process.env.PATH = [shadow, path.join(home, ".local", "bin")].join(":");
      yield* Effect.addFinalizer(() => Effect.sync(() => (process.env.PATH = previous)));

      const command = yield* commandIn({ home });
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(path.join(home, ".local", "bin", "supacode"));
      expect(installed.onPath).toBe(false);
      yield* fs.remove(path.join(shadow, "supacode"));
      expect((yield* command.state).onPath).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the Windows PATH alone when it cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const userPath = "C:\\Users\\Me\\npm;%USERPROFILE%\\tools";
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      registry.failReads = true;
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("left unchanged");
      expect(registry).toMatchObject({ path: userPath, writes: 0 });

      registry.failReads = false;
      const launcherDir = DesktopCliShim.launcherPath(
        environmentFor(yield* Path.Path, { home, baseDir: `${home}/.supacode`, platform: "win32" }),
      ).replace(/[\\/]supacode\.cmd$/, "");
      yield* command.install;
      expect(registry.path).toBe(`${userPath};${launcherDir}`);
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("does not claim or remove a Windows PATH entry the user added", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcherDir = path.dirname(
        DesktopCliShim.launcherPath(
          environmentFor(path, { home, baseDir: path.join(home, ".supacode"), platform: "win32" }),
        ),
      );
      const userPath = `C:\\Tools;${launcherDir}`;
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      expect((yield* command.state).installedPath).toBeNull();
      expect((yield* command.install).installedPath).toBeNull();
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
      expect(registry.writes).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("detects Windows commands earlier in the system or user PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const scope of ["machine", "user"] as const) {
        const home = yield* fs.makeTempDirectoryScoped();
        const shadow = path.join(home, "shadow");
        yield* fs.makeDirectory(shadow);
        const shadowCommand = path.join(shadow, "supacode.exe");
        yield* fs.writeFileString(shadowCommand, "existing command");
        const { spawner } = fakePowerShell(
          scope === "user" ? shadow : "",
          scope === "machine" ? shadow : "",
        );
        const command = yield* commandIn({ home, platform: "win32" }, spawner);

        expect((yield* command.install).onPath).toBe(false);
        expect((yield* command.state).onPath).toBe(false);
        yield* fs.remove(shadowCommand);
        expect((yield* command.state).onPath).toBe(true);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("uses Windows PATHEXT order and rejects an excluded launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const { registry, spawner } = fakePowerShell("");
      const command = yield* commandIn({ home, platform: "win32" }, spawner);
      expect((yield* command.install).onPath).toBe(true);

      const executable = path.join(home, ".supacode", "bin", "supacode.exe");
      yield* fs.writeFileString(executable, "another command");
      registry.pathExt = ".EXE;.CMD";
      expect((yield* command.state).onPath).toBe(false);
      registry.pathExt = ".CMD;.EXE";
      expect((yield* command.state).onPath).toBe(true);
      registry.pathExt = ".EXE";
      yield* fs.remove(executable);
      expect((yield* command.state).onPath).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("migrates its Windows PATH entry after the previous Supacode home is removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const oldBaseDir = path.join(home, "old-supacode");
      const newBaseDir = path.join(home, "new-supacode");
      const { registry, spawner } = fakePowerShell("C:\\Tools;%USERPROFILE%\\manual");
      const before = yield* commandIn({ home, baseDir: oldBaseDir, platform: "win32" }, spawner);
      yield* before.install;
      yield* fs.remove(oldBaseDir, { recursive: true });

      const after = yield* commandIn({ home, baseDir: newBaseDir, platform: "win32" }, spawner);
      expect((yield* after.state).installedPath).toBeNull();
      expect((yield* after.install).onPath).toBe(true);
      expect(registry.path).toBe(`C:\\Tools;%USERPROFILE%\\manual;${path.join(newBaseDir, "bin")}`);
      yield* after.uninstall;
      expect(registry.path).toBe("C:\\Tools;%USERPROFILE%\\manual");
    }).pipe(Effect.scoped),
  );

  it.effect("removes an owned Windows entry from a previous Supacode home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const { registry, spawner } = fakePowerShell("C:\\Tools");
      const before = yield* commandIn(
        { home, baseDir: path.join(home, "old-supacode"), platform: "win32" },
        spawner,
      );
      yield* before.install;
      const after = yield* commandIn(
        { home, baseDir: path.join(home, "new-supacode"), platform: "win32" },
        spawner,
      );

      yield* after.uninstall;
      expect(registry.path).toBe("C:\\Tools");
    }).pipe(Effect.scoped),
  );

  it.effect("migrates recorded legacy Windows entries from the old or copied state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const copied of [false, true]) {
        const home = yield* fs.makeTempDirectoryScoped();
        const oldBaseDir = path.join(home, "old-supacode");
        const newBaseDir = path.join(home, "new-supacode");
        const oldBin = path.join(oldBaseDir, "bin");
        const legacyMarker = path.join(
          copied ? newBaseDir : oldBaseDir,
          "userdata",
          "cli-command-path-entry",
        );
        yield* fs.makeDirectory(path.dirname(legacyMarker), { recursive: true });
        yield* fs.writeFileString(legacyMarker, `${oldBin}\n`);
        const { registry, spawner } = fakePowerShell(`C:\\Tools;${oldBin}`);
        const command = yield* commandIn({ home, baseDir: newBaseDir, platform: "win32" }, spawner);

        expect((yield* command.install).onPath).toBe(true);
        expect(registry.path).toBe(`C:\\Tools;${path.join(newBaseDir, "bin")}`);
        expect(yield* fs.exists(legacyMarker)).toBe(false);
        yield* command.uninstall;
        expect(registry.path).toBe("C:\\Tools");
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves a manually added new directory while removing the previous owned entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const { registry, spawner } = fakePowerShell("C:\\Tools");
        const before = yield* commandIn(
          { home, baseDir: path.join(home, "old-supacode"), platform: "win32" },
          spawner,
        );
        yield* before.install;
        const newBaseDir = path.join(home, "new-supacode");
        const manualPath = path.join(newBaseDir, "bin");
        registry.path += `;${manualPath}`;
        const after = yield* commandIn({ home, baseDir: newBaseDir, platform: "win32" }, spawner);

        expect((yield* after.install).installedPath).toBeNull();
        expect(registry.path).toBe(`C:\\Tools;${manualPath}`);
        yield* after.uninstall;
        expect(registry.path).toBe(`C:\\Tools;${manualPath}`);
      }).pipe(Effect.scoped),
  );

  it.effect("restores Windows PATH when its ownership record cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const appData = path.join(home, "AppData", "Roaming");
      yield* fs.makeDirectory(appData, { recursive: true });
      yield* fs.writeFileString(path.join(appData, "Supacode"), "occupied");
      const { registry, spawner } = fakePowerShell("C:\\Tools");
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("Could not record");
      expect(registry.path).toBe("C:\\Tools");
    }).pipe(Effect.scoped),
  );

  it.effect("offers nothing for a development build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = yield* commandIn({
        home: yield* fs.makeTempDirectoryScoped(),
        isPackaged: false,
      });
      expect((yield* command.state).supported).toBe(false);
    }).pipe(Effect.scoped),
  );
});
