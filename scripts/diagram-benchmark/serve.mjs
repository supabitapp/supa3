import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [dependencies, outputDirectory, port = "0"] = process.argv.slice(2);
if (!dependencies || !outputDirectory)
  throw new Error("Usage: node serve.mjs <dependency-directory> <output-directory> [port]");
const directory = NodePath.resolve(outputDirectory, "mermaid-browser");
const { version } = JSON.parse(
  await NodeFSP.readFile(
    NodePath.resolve(dependencies, "node_modules/mermaid/package.json"),
    "utf8",
  ),
);
await NodeFSP.mkdir(directory, { recursive: true });
const results = new Map();
const mime = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
};
const server = NodeHttp.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (path === "/result") {
        const { result, ...metadata } = JSON.parse(body);
        results.set(result.fixture, result);
        await NodeFSP.writeFile(
          NodePath.resolve(directory, "results.json"),
          JSON.stringify(
            {
              name: "mermaid-browser",
              version,
              ...metadata,
              results: [...results.values()],
            },
            null,
            2,
          ),
        );
      } else if (/^\/output\/[\w-]+\.svg$/.test(path)) {
        await NodeFSP.writeFile(NodePath.resolve(directory, path.slice("/output/".length)), body);
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(204).end();
      return;
    }
    if (path === "/") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          '<!doctype html><html><head><meta charset="utf-8"><title>Diagram benchmark</title></head><body><script type="module" src="/browser.mjs"></script></body></html>',
        );
      return;
    }
    const dependency = path.startsWith("/deps/");
    const base = dependency
      ? NodePath.resolve(dependencies, "node_modules")
      : NodeURL.fileURLToPath(new URL(".", import.meta.url));
    const target = NodePath.resolve(base, dependency ? path.slice(6) : path.slice(1));
    if (!target.startsWith(NodePath.resolve(base) + NodePath.sep)) throw new Error("Invalid path");
    const content = await NodeFSP.readFile(target);
    response
      .writeHead(200, {
        "content-type": mime[NodePath.extname(target)] ?? "application/octet-stream",
      })
      .end(content);
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
server.listen(Number(port), "127.0.0.1", () =>
  console.log(JSON.stringify({ pid: process.pid, address: server.address() })),
);
