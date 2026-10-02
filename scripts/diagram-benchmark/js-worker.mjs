import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [directory, mode] = process.argv.slice(2);
if (!directory || !["ascii", "svg"].includes(mode)) {
  throw new Error("Usage: node js-worker.mjs <dependency-directory> <ascii|svg>");
}
const { renderMermaidASCII, renderMermaidSVG } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(directory, "node_modules/beautiful-mermaid/dist/index.js"))
    .href
);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({ ready: true, renderer: `beautiful-mermaid-${mode}`, version: "1.1.3" });
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const start = performance.now();
  try {
    const { source } = JSON.parse(line);
    const output =
      mode === "ascii"
        ? renderMermaidASCII(source, { colorMode: "none" })
        : renderMermaidSVG(source);
    send({ output, renderMs: performance.now() - start });
  } catch (error) {
    send({ error: String(error), renderMs: performance.now() - start });
  }
}
