import { Fragment, type ReactNode } from "react";

import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { useWidgetFrame } from "./context";

const SCENES = {
  calm: ["       *", "      _|_", " ~~ ~/___\\~ ~~", "   ~~     ~~"],
  moored: [" |    |\\", "=|====|_\\__==", " |  \\_____/ ~~", "~~~~~~~~~~~~~~"],
  dock: ["   ______", "  |    |", "  |    J   *", "__|______|__"],
  horizon: ["  .     *     .", "_______________", " ~~  ~~~   ~~", "   ~~    ~~~"],
  chart: ["   .  .  .  *", "  .", " x   ~~   ~~", "~~~~~~~~~~~~~"],
  anchor: ["      |", "    --+--", "  \\__|__/  *", "~~~~~~~~~~~~~~"],
  lighthouse: ["      /\\", "  -- |**|", "     |  |", "~~~~~|__|~~~~"],
  bottle: ["        _", "   ~~  [ ]>  *", " ~~~~~~~~~~~~", "   ~~    ~~"],
  rafted: ["  |\\  |\\  |\\", "__|_\\_|_\\_|_\\_", "\\______________/", "~~~~~~~~~~~~~~~~~"],
} as const;

export type SceneName = keyof typeof SCENES;

function sceneLines(name: SceneName) {
  return SCENES[name].map((line, row) => ({
    id: `${name}-${row}`,
    parts: line.split("*").map((text, part) => ({ id: `${name}-${row}-${part}`, text })),
  }));
}

function Scene({ name }: { name: SceneName }) {
  return (
    <pre
      aria-hidden
      className="m-0 font-mono text-3xs leading-2.75 text-muted-foreground/70 select-none"
    >
      {sceneLines(name).map((line) => (
        <div key={line.id}>
          {line.parts.map((part, index) => (
            <Fragment key={part.id}>
              {index > 0 ? <span className="text-warning">*</span> : null}
              {part.text}
            </Fragment>
          ))}
        </div>
      ))}
    </pre>
  );
}

export function WidgetEmpty(props: {
  scene: SceneName;
  title: string;
  hint?: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  const { bodyHeight, preview } = useWidgetFrame();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
      {bodyHeight > (props.action ? 150 : 110) ? (
        <div className="mb-1">
          <Scene name={props.scene} />
        </div>
      ) : null}
      <p className="text-sm font-medium text-foreground">{props.title}</p>
      {props.hint ? (
        <p className="line-clamp-2 max-w-72 text-xs text-balance text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
      {props.action ? (
        <Button
          size="xs"
          variant="outline"
          className="mt-1.5"
          tabIndex={preview ? -1 : undefined}
          onClick={props.action.onClick}
        >
          {props.action.label}
        </Button>
      ) : null}
    </div>
  );
}

const SKELETON_WIDTHS = [64, 48, 72, 56, 40, 68];

export function WidgetSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-2.5 px-2">
          <Skeleton shape="pill" className="size-1.5" />
          <Skeleton
            className="h-2.5"
            style={{ width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%` }}
          />
          <Skeleton className="ml-auto h-2.5 w-7" />
        </div>
      ))}
    </div>
  );
}

export function StatSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex h-full flex-col justify-center gap-2 px-3"
    >
      <Skeleton className="h-2.5 w-20" />
      <Skeleton className="h-6 w-24" />
    </div>
  );
}
