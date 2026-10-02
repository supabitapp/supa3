import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [directory, mode] = process.argv.slice(2);
if (!directory || !["patched", "standalone"].includes(mode)) {
  throw new Error("Usage: node ascii-worker.mjs <artifact-directory> <patched|standalone>");
}
const { renderMermaidASCII } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(directory, `ascii-${mode}.js`)).href
);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({
  ready: true,
  renderer: `beautiful-mermaid-ascii-${mode}`,
  version: "1.1.3",
  experimentalPatch: mode === "patched",
});
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const start = performance.now();
  try {
    const { source } = JSON.parse(line);
    const output = renderMermaidASCII(source, { colorMode: "none" });
    send({ output, renderMs: performance.now() - start });
  } catch (error) {
    send({ error: String(error), renderMs: performance.now() - start });
  }
}
