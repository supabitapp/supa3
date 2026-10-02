import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

const destination = process.argv[2];
if (!destination || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/diagram-benchmark/prepare-js.ts <artifact-directory>");
}

await NodeFSP.mkdir(NodePath.resolve(destination), { recursive: true });
const artifactDirectory = await NodeFSP.realpath(NodePath.resolve(destination));
const repositoryDirectory = await NodeFSP.realpath(NodePath.resolve(import.meta.dirname, "../.."));
const relativeDirectory = NodePath.relative(repositoryDirectory, artifactDirectory);
if (
  !relativeDirectory ||
  (relativeDirectory.split(NodePath.sep)[0] !== ".." && !NodePath.isAbsolute(relativeDirectory))
) {
  throw new Error("Build artifacts must be outside the repository");
}

const pins = {
  "beautiful-mermaid": "1.1.3",
  mermaid: "12.1.0",
  esbuild: "0.25.12",
};
await NodeFSP.writeFile(
  NodePath.join(artifactDirectory, "package.json"),
  `${JSON.stringify({ private: true, type: "module", dependencies: pins }, null, 2)}\n`,
);
NodeChildProcess.execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: artifactDirectory,
  stdio: "inherit",
});

const packageDirectory = NodePath.join(artifactDirectory, "node_modules/beautiful-mermaid");
const experimentalSourceDirectory = NodePath.join(artifactDirectory, "experimental-ascii-source");
await NodeFSP.cp(NodePath.join(packageDirectory, "src"), experimentalSourceDirectory, {
  recursive: true,
});
const patchedFile = NodePath.join(experimentalSourceDirectory, "ascii/grid.ts");
const originalSource = await NodeFSP.readFile(patchedFile, "utf8");
const before = "highestPosition = highestPositionPerLevel[childLevel]!";
const after = "highestPosition = highestPositionPerLevel[childLevel] ?? 0";
if (originalSource.split(before).length !== 2) {
  throw new Error("Expected exactly one occurrence of the experimental ASCII level lookup patch");
}
const patchedSource = originalSource.replace(before, after);
await NodeFSP.writeFile(patchedFile, patchedSource);

const { build } = await import(
  NodeURL.pathToFileURL(NodePath.join(artifactDirectory, "node_modules/esbuild/lib/main.js")).href
);
const entries = [
  {
    name: "ascii-patched.js",
    module: NodePath.join(experimentalSourceDirectory, "ascii/index.ts"),
    exportName: "renderMermaidASCII",
    experimentalPatch: true,
  },
  {
    name: "ascii-standalone.js",
    module: NodePath.join(packageDirectory, "src/ascii/index.ts"),
    exportName: "renderMermaidASCII",
    experimentalPatch: false,
  },
  {
    name: "ascii-public.js",
    module: "beautiful-mermaid",
    exportName: "renderMermaidASCII",
    experimentalPatch: false,
  },
  {
    name: "svg.js",
    module: "beautiful-mermaid",
    exportName: "renderMermaidSVG",
    experimentalPatch: false,
  },
];
const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const bundles = [];
for (const entry of entries) {
  const outputPath = NodePath.join(artifactDirectory, entry.name);
  await build({
    stdin: {
      contents: `export { ${entry.exportName} } from ${JSON.stringify(entry.module)};`,
      resolveDir: artifactDirectory,
      sourcefile: `${entry.name}.entry.js`,
      loader: "js",
    },
    outfile: outputPath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    logLevel: "warning",
  });
  const content = await NodeFSP.readFile(outputPath);
  bundles.push({
    file: entry.name,
    experimentalPatch: entry.experimentalPatch,
    bytes: content.byteLength,
    gzipBytes: NodeZlib.gzipSync(content).byteLength,
    sha256: sha256(content),
  });
}

const lockfile = await NodeFSP.readFile(NodePath.join(artifactDirectory, "package-lock.json"));
const artifacts = {
  pins,
  packageLockSha256: sha256(lockfile),
  bundler: { platform: "browser", target: "es2022", format: "esm", minify: true },
  experimentalPatch: {
    file: "src/ascii/grid.ts",
    before,
    after,
    originalSha256: sha256(originalSource),
    patchedSha256: sha256(patchedSource),
  },
  bundles,
};
await NodeFSP.writeFile(
  NodePath.join(artifactDirectory, "artifacts.json"),
  `${JSON.stringify(artifacts, null, 2)}\n`,
);
console.log(JSON.stringify({ artifactDirectory, ...artifacts }));
