import { createDiagramRenderer } from "@t3tools/client-runtime/diagram-rendering";
import { renderMermaidAscii } from "@t3tools/mermaid-ascii";
import {
  createWorkletRuntime,
  isBundleModeEnabled,
  runOnRuntimeAsync,
  type WorkletRuntime,
} from "react-native-worklets";

let runtime: WorkletRuntime | undefined;

function renderOnRuntime(source: string) {
  "worklet";
  try {
    return renderMermaidAscii(source);
  } catch {
    return null;
  }
}

const renderer = createDiagramRenderer(async (source) => {
  if (!isBundleModeEnabled()) {
    throw new Error("Diagram rendering requires Worklets Bundle Mode");
  }
  runtime ??= createWorkletRuntime({
    name: "mermaid-ascii",
    enableEventLoop: false,
    enableNetworking: false,
  });
  return runOnRuntimeAsync(runtime, renderOnRuntime, source);
});

export const renderMermaidDiagram = renderer.render;
