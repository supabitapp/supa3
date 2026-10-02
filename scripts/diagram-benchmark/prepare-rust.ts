import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const artifactArgument = process.argv[2];
if (!artifactArgument || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/diagram-benchmark/prepare-rust.ts <artifact-directory>");
}

const artifactDirectory = NodePath.resolve(artifactArgument);
const repositoryDirectory = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const relativeDirectory = NodePath.relative(repositoryDirectory, artifactDirectory);
if (
  !relativeDirectory ||
  (relativeDirectory.split(NodePath.sep)[0] !== ".." && !NodePath.isAbsolute(relativeDirectory))
) {
  throw new Error("Build artifacts must be outside the repository");
}

await NodeFSP.mkdir(NodePath.join(artifactDirectory, "src"), { recursive: true });
await NodeFSP.writeFile(
  NodePath.join(artifactDirectory, "Cargo.toml"),
  `[package]
name = "diagram-rust-worker"
version = "0.1.0"
edition = "2024"

[dependencies]
mermaid-rs-renderer = { version = "=0.3.1", default-features = false }
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"

[profile.release]
lto = true
codegen-units = 1
strip = true
`,
);
await NodeFSP.copyFile(
  new URL("./rust-worker.rs", import.meta.url),
  NodePath.join(artifactDirectory, "src/main.rs"),
);

const build = NodeChildProcess.spawnSync("cargo", ["build", "--release"], {
  cwd: artifactDirectory,
  env: { ...process.env, CARGO_TARGET_DIR: NodePath.join(artifactDirectory, "target") },
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`Cargo build failed with status ${build.status}`);

console.log(
  JSON.stringify({
    executable: NodePath.join(
      artifactDirectory,
      "target/release",
      NodeOS.type() === "Windows_NT" ? "diagram-rust-worker.exe" : "diagram-rust-worker",
    ),
    artifactDirectory,
    renderer: "mermaid-rs-renderer",
    version: "0.3.1",
  }),
);
