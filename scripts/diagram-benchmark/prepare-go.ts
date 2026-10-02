import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const revision = "5f00e3d9ac9fc96a19859d502333e35b87d2ffea";
const moduleVersion = "v0.0.0-20260908213847-5f00e3d9ac9f";
const destination = process.argv[2];

if (!destination || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/diagram-benchmark/prepare-go.ts <artifact-directory>");
}

NodeFS.mkdirSync(NodePath.resolve(destination), { recursive: true });
const artifactDirectory = NodeFS.realpathSync(NodePath.resolve(destination));
const repositoryRoot = NodeFS.realpathSync(NodePath.resolve(import.meta.dirname, "../.."));
const repositoryRelativePath = NodePath.relative(repositoryRoot, artifactDirectory);
if (
  repositoryRelativePath === "" ||
  (repositoryRelativePath !== ".." &&
    !repositoryRelativePath.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(repositoryRelativePath))
) {
  throw new Error("The artifact directory must be outside the repository");
}

NodeFS.copyFileSync(
  NodePath.join(import.meta.dirname, "go-worker.go"),
  NodePath.join(artifactDirectory, "main.go"),
);
NodeFS.writeFileSync(
  NodePath.join(artifactDirectory, "go.mod"),
  `module t3-diagram-benchmark/go\n\ngo 1.21\n\nrequire github.com/AlexanderGrooff/mermaid-ascii ${moduleVersion}\n`,
);
NodeChildProcess.execFileSync("go", ["mod", "tidy"], { cwd: artifactDirectory, stdio: "inherit" });
const executableSuffix = NodeChildProcess.execFileSync("go", ["env", "GOEXE"], {
  cwd: artifactDirectory,
  encoding: "utf8",
}).trim();
const executable = NodePath.join(artifactDirectory, `mermaid-ascii-worker${executableSuffix}`);
NodeChildProcess.execFileSync(
  "go",
  ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${revision}`, "-o", executable, "."],
  { cwd: artifactDirectory, stdio: "inherit" },
);
console.log(
  JSON.stringify({ executable, version: revision, bytes: NodeFS.statSync(executable).size }),
);
