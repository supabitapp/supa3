import { createContext, use } from "react";

import type { ComposerHandleRef } from "../../../composerHandleContext";
import type { ProtoData } from "../data";
import { GRID_GAP, HEADING_HEIGHT, ROW_HEIGHT, SIZES, type WidgetSize } from "./layout";

export interface WidgetEnv {
  readonly data: ProtoData;
  readonly composerRef: ComposerHandleRef;
}

export const WidgetEnvContext = createContext<WidgetEnv | null>(null);

export function useWidgetEnv(): WidgetEnv {
  const env = use(WidgetEnvContext);
  if (!env) throw new Error("Widget rendered outside the widget grid");
  return env;
}

export interface WidgetFrame {
  readonly id: string;
  readonly size: WidgetSize;
  readonly columns: number;
  readonly bodyHeight: number;
  readonly preview: boolean;
}

export const WidgetFrameContext = createContext<WidgetFrame>({
  id: "",
  size: "m",
  columns: 2,
  bodyHeight: ROW_HEIGHT - HEADING_HEIGHT,
  preview: false,
});

export const useWidgetFrame = () => use(WidgetFrameContext);

export function bodyHeightFor(size: WidgetSize, bare: boolean) {
  const rows = SIZES[size].r;
  return rows * ROW_HEIGHT + (rows - 1) * GRID_GAP - (bare ? 0 : HEADING_HEIGHT + 6);
}

export const ROW_PX = 32;

export const rowsThatFit = (bodyHeight: number) =>
  Math.max(1, Math.floor((bodyHeight - 18) / ROW_PX));
