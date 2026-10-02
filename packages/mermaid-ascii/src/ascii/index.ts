import { parseMermaid } from "../parser.ts";
import { convertToAsciiGraph } from "./converter.ts";
import { createMapping } from "./grid.ts";
import { drawGraph } from "./draw.ts";
import { canvasToString, flipCanvasVertically, flipRoleCanvasVertically } from "./canvas.ts";
import { renderSequenceAscii } from "./sequence.ts";
import { renderClassAscii } from "./class-diagram.ts";
import { renderErAscii } from "./er-diagram.ts";
import { renderXYChartAscii } from "./xychart.ts";
import { DEFAULT_ASCII_THEME } from "./ansi.ts";
import type { AsciiConfig, AsciiTheme, ColorMode } from "./types.ts";
export interface AsciiRenderOptions {
  useAscii?: boolean;
  paddingX?: number;
  paddingY?: number;
  boxBorderPadding?: number;
}
function detectDiagramType(text: string): "flowchart" | "sequence" | "class" | "er" | "xychart" {
  const firstLine = text.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
  if (/^xychart(-beta)?\b/.test(firstLine)) return "xychart";
  if (/^sequencediagram\s*$/.test(firstLine)) return "sequence";
  if (/^classdiagram\s*$/.test(firstLine)) return "class";
  if (/^erdiagram\s*$/.test(firstLine)) return "er";
  return "flowchart";
}
export function renderMermaidAscii(text: string, options: AsciiRenderOptions = {}): string {
  const config: AsciiConfig = {
    useAscii: options.useAscii ?? false,
    paddingX: options.paddingX ?? 5,
    paddingY: options.paddingY ?? 5,
    boxBorderPadding: options.boxBorderPadding ?? 1,
    graphDirection: "TD",
  };
  const colorMode: ColorMode = "none";
  const theme: AsciiTheme = DEFAULT_ASCII_THEME;
  const diagramType = detectDiagramType(text);
  switch (diagramType) {
    case "xychart":
      return renderXYChartAscii(text, config, colorMode, theme);
    case "sequence":
      return renderSequenceAscii(text, config, colorMode, theme);
    case "class":
      return renderClassAscii(text, config, colorMode, theme);
    case "er":
      return renderErAscii(text, config, colorMode, theme);
    case "flowchart":
    default: {
      const parsed = parseMermaid(text);
      if (parsed.direction === "LR" || parsed.direction === "RL") {
        config.graphDirection = "LR";
      } else {
        config.graphDirection = "TD";
      }
      const graph = convertToAsciiGraph(parsed, config);
      createMapping(graph);
      drawGraph(graph);
      if (parsed.direction === "BT") {
        flipCanvasVertically(graph.canvas);
        flipRoleCanvasVertically(graph.roleCanvas);
      }
      return canvasToString(graph.canvas, {
        roleCanvas: graph.roleCanvas,
        colorMode,
        theme,
      });
    }
  }
}
