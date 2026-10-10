import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@supacode/contracts";
import { type ComponentType, useId } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

export type SidebarStageBackdropVariant = "nightly" | "dev" | "release";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

// A wide viewBox keeps the 96-unit art height at a fixed scale while sidebar resizing reveals
// more horizontal canvas instead of zooming the scene.
const STAGE_BACKDROP_VIEW_BOX = "0 0 8192 96";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string | null,
): SidebarStageBackdropVariant | null {
  const normalized = stageLabel?.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  if (normalized === undefined || normalized === "latest") return "release";
  return null;
}

const ENVIRONMENT_IDENTIFICATION_MODES = ["artwork", "pill", "none"] as const;

export function resolveEnvironmentIdentificationModes(stageLabel: string | null) {
  const available = {
    artwork: resolveSidebarStageBackdropVariant(stageLabel) !== null,
    pill: resolveEnvironmentIdentificationPillLabel(stageLabel) !== null,
    none: true,
  } satisfies Record<EnvironmentIdentificationMode, boolean>;
  return ENVIRONMENT_IDENTIFICATION_MODES.filter((mode) => available[mode]);
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string | null,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel?.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string | null {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): SidebarStageBackdropVariant | null {
  const stageLabel = useEnvironmentStageLabel();
  return enabled ? resolveSidebarStageBackdropVariant(stageLabel) : null;
}

/** Stage-channel header art; palettes mirror the per-channel app icons in `assets/`. */
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

const STAGE_BACKDROP_ART = {
  nightly: SleighRideArt,
  dev: WireframeArt,
  release: MeteorShowerArt,
} satisfies Record<SidebarStageBackdropVariant, ComponentType<{ compact?: boolean }>>;

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  const Art = STAGE_BACKDROP_ART[variant];
  return <Art />;
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  const Art = STAGE_BACKDROP_ART[variant];
  return <Art compact />;
}

type StageStar = { cx: number; cy: number; r: number; opacity: number };
type StageSparkle = { x: number; y: number };

function NightSkyGradient({ id }: { id: string }) {
  return (
    <linearGradient
      id={id}
      x1="24"
      y1="0"
      x2="264"
      y2="96"
      gradientUnits="userSpaceOnUse"
      spreadMethod="reflect"
    >
      <stop style={{ stopColor: "var(--stage-night-bottom)" }} />
      <stop offset="0.5" style={{ stopColor: "var(--stage-night-mid)" }} />
      <stop offset="1" style={{ stopColor: "var(--stage-night-top)" }} />
    </linearGradient>
  );
}

function NightStarsPattern({
  id,
  width,
  stars,
  sparkles,
}: {
  id: string;
  width: number;
  stars: ReadonlyArray<StageStar>;
  sparkles: ReadonlyArray<StageSparkle>;
}) {
  return (
    <pattern id={id} width={width} height="96" patternUnits="userSpaceOnUse">
      <g style={{ fill: "var(--stage-night-line)" }}>
        {stars.map((star) => (
          <circle
            key={`${star.cx}-${star.cy}`}
            cx={star.cx}
            cy={star.cy}
            r={star.r}
            fillOpacity={star.opacity}
          />
        ))}
      </g>
      <g
        style={{ stroke: "var(--stage-night-sparkle)" }}
        strokeLinecap="round"
        strokeOpacity="0.7"
        strokeWidth="0.6"
      >
        {sparkles.map(({ x, y }) => (
          <path key={`${x}-${y}`} d={`M${x - 1.5} ${y}H${x + 1.5}M${x} ${y - 1.5}V${y + 1.5}`} />
        ))}
      </g>
    </pattern>
  );
}

const METEOR_SHOWER_STARS: ReadonlyArray<StageStar> = [
  { cx: 12.2, cy: 50.1, r: 0.3, opacity: 0.3 },
  { cx: 254.3, cy: 56.4, r: 0.3, opacity: 0.3 },
  { cx: 168.2, cy: 35.7, r: 0.4, opacity: 0.5 },
  { cx: 37.5, cy: 5.4, r: 0.9, opacity: 0.9 },
  { cx: 16.6, cy: 20.8, r: 0.3, opacity: 0.3 },
  { cx: 62.8, cy: 0.6, r: 0.5, opacity: 0.5 },
  { cx: 174.5, cy: 21.9, r: 0.3, opacity: 0.5 },
  { cx: 204.4, cy: 31.9, r: 0.4, opacity: 0.5 },
  { cx: 33.5, cy: 22, r: 0.4, opacity: 0.3 },
  { cx: 36.4, cy: 65.3, r: 0.3, opacity: 0.7 },
  { cx: 108.5, cy: 19.7, r: 0.4, opacity: 0.7 },
  { cx: 112.1, cy: 40.8, r: 0.3, opacity: 0.6 },
  { cx: 118.3, cy: 24.3, r: 0.3, opacity: 0.6 },
  { cx: 232.8, cy: 36.8, r: 0.4, opacity: 0.5 },
  { cx: 135.5, cy: 43.9, r: 0.4, opacity: 0.4 },
  { cx: 21.5, cy: 8.4, r: 0.3, opacity: 0.5 },
  { cx: 125.6, cy: 17.6, r: 0.3, opacity: 0.6 },
  { cx: 130.1, cy: 58.7, r: 1, opacity: 0.9 },
  { cx: 91.5, cy: 58.1, r: 0.4, opacity: 0.7 },
  { cx: 2.8, cy: 57.1, r: 0.3, opacity: 0.3 },
  { cx: 3.4, cy: 58.9, r: 0.3, opacity: 0.3 },
  { cx: 103.3, cy: 6.7, r: 0.3, opacity: 0.3 },
  { cx: 233.8, cy: 57.9, r: 0.3, opacity: 0.5 },
  { cx: 147.6, cy: 58.9, r: 0.4, opacity: 0.5 },
  { cx: 2.8, cy: 17, r: 0.3, opacity: 0.5 },
  { cx: 220.7, cy: 55.1, r: 0.3, opacity: 0.3 },
  { cx: 98.7, cy: 39.3, r: 0.3, opacity: 0.3 },
  { cx: 65.6, cy: 27.5, r: 0.5, opacity: 0.3 },
  { cx: 260.9, cy: 58.5, r: 0.3, opacity: 0.4 },
  { cx: 269.6, cy: 51.8, r: 0.3, opacity: 0.5 },
  { cx: 113.9, cy: 67.4, r: 0.9, opacity: 0.9 },
  { cx: 214.1, cy: 30.3, r: 0.6, opacity: 0.7 },
  { cx: 171.1, cy: 21.3, r: 0.3, opacity: 0.5 },
  { cx: 257.8, cy: 51.4, r: 0.4, opacity: 0.5 },
  { cx: 201.4, cy: 11.3, r: 0.5, opacity: 0.4 },
  { cx: 199, cy: 58, r: 0.9, opacity: 0.9 },
  { cx: 230.6, cy: 32.7, r: 0.3, opacity: 0.6 },
  { cx: 273.7, cy: 21.9, r: 0.6, opacity: 0.3 },
  { cx: 61.9, cy: 34.2, r: 0.3, opacity: 0.6 },
  { cx: 127.9, cy: 58.2, r: 0.4, opacity: 0.6 },
  { cx: 14, cy: 34.5, r: 0.6, opacity: 0.3 },
  { cx: 59.7, cy: 19.3, r: 1, opacity: 0.9 },
  { cx: 16.5, cy: 9.7, r: 0.6, opacity: 0.5 },
  { cx: 211.6, cy: 70.1, r: 0.3, opacity: 0.7 },
  { cx: 215.1, cy: 47.7, r: 0.6, opacity: 0.3 },
  { cx: 134.4, cy: 66.6, r: 0.4, opacity: 0.6 },
  { cx: 244, cy: 53.2, r: 0.4, opacity: 0.7 },
  { cx: 69.5, cy: 13.6, r: 0.3, opacity: 0.3 },
  { cx: 28.3, cy: 45.7, r: 0.4, opacity: 0.6 },
  { cx: 71.9, cy: 53.3, r: 0.3, opacity: 0.7 },
  { cx: 216.8, cy: 27.3, r: 0.4, opacity: 0.3 },
  { cx: 156.9, cy: 31.8, r: 0.4, opacity: 0.3 },
  { cx: 155.5, cy: 11.1, r: 0.4, opacity: 0.7 },
  { cx: 228.4, cy: 47.4, r: 0.6, opacity: 0.4 },
  { cx: 275.9, cy: 70.6, r: 0.6, opacity: 0.6 },
  { cx: 127.5, cy: 18.1, r: 0.3, opacity: 0.4 },
  { cx: 51.6, cy: 58.7, r: 0.4, opacity: 0.5 },
  { cx: 38.6, cy: 67.7, r: 0.6, opacity: 0.6 },
  { cx: 74.7, cy: 9.5, r: 0.4, opacity: 0.7 },
  { cx: 99.1, cy: 14, r: 0.4, opacity: 0.4 },
  { cx: 84.4, cy: 38.3, r: 0.3, opacity: 0.7 },
  { cx: 73.7, cy: 14.8, r: 0.6, opacity: 0.6 },
  { cx: 52.3, cy: 24.1, r: 0.5, opacity: 0.3 },
  { cx: 277.5, cy: 17.3, r: 0.3, opacity: 0.6 },
  { cx: 76.7, cy: 46.3, r: 0.4, opacity: 0.6 },
  { cx: 216.2, cy: 50.4, r: 0.4, opacity: 0.7 },
  { cx: 118.8, cy: 64.6, r: 0.4, opacity: 0.7 },
  { cx: 243.7, cy: 65.3, r: 0.5, opacity: 0.6 },
  { cx: 42.9, cy: 13.4, r: 0.6, opacity: 0.6 },
  { cx: 272.6, cy: 46.4, r: 0.3, opacity: 0.6 },
  { cx: 227, cy: 42.3, r: 0.6, opacity: 0.4 },
  { cx: 156.2, cy: 26.3, r: 0.6, opacity: 0.3 },
  { cx: 20, cy: 3.9, r: 0.3, opacity: 0.6 },
  { cx: 34.5, cy: 11.4, r: 0.3, opacity: 0.3 },
  { cx: 49.3, cy: 34.4, r: 0.5, opacity: 0.3 },
  { cx: 45.6, cy: 11.5, r: 0.6, opacity: 0.7 },
  { cx: 179.2, cy: 39.1, r: 0.6, opacity: 0.4 },
  { cx: 116.2, cy: 37.2, r: 0.3, opacity: 0.6 },
  { cx: 175.3, cy: 34.2, r: 0.3, opacity: 0.6 },
  { cx: 92.1, cy: 70.7, r: 0.3, opacity: 0.6 },
  { cx: 79.6, cy: 6.3, r: 0.3, opacity: 0.3 },
  { cx: 164.6, cy: 51.4, r: 0.3, opacity: 0.6 },
  { cx: 206.2, cy: 48.9, r: 0.4, opacity: 0.5 },
  { cx: 98.8, cy: 57.3, r: 0.3, opacity: 0.7 },
  { cx: 44.4, cy: 61.2, r: 0.4, opacity: 0.7 },
  { cx: 65.1, cy: 28.7, r: 0.5, opacity: 0.5 },
  { cx: 119.9, cy: 59.4, r: 0.3, opacity: 0.3 },
  { cx: 65.1, cy: 49.6, r: 0.3, opacity: 0.3 },
  { cx: 168.6, cy: 5.5, r: 0.8, opacity: 0.9 },
  { cx: 111.7, cy: 64.9, r: 0.3, opacity: 0.5 },
  { cx: 196.6, cy: 31.5, r: 0.3, opacity: 0.7 },
  { cx: 280.9, cy: 28.9, r: 0.5, opacity: 0.5 },
  { cx: 285.5, cy: 32.2, r: 0.4, opacity: 0.4 },
  { cx: 85.9, cy: 34.8, r: 0.4, opacity: 0.7 },
  { cx: 267.4, cy: 57.3, r: 0.5, opacity: 0.7 },
  { cx: 144.8, cy: 21.4, r: 1, opacity: 0.9 },
  { cx: 257.8, cy: 32.7, r: 0.3, opacity: 0.4 },
  { cx: 246.6, cy: 52, r: 0.3, opacity: 0.6 },
  { cx: 180.2, cy: 62.1, r: 0.5, opacity: 0.6 },
  { cx: 137.5, cy: 5.5, r: 0.3, opacity: 0.3 },
  { cx: 280.3, cy: 55.4, r: 0.3, opacity: 0.3 },
  { cx: 264.7, cy: 60.2, r: 1, opacity: 0.9 },
  { cx: 16.8, cy: 52.6, r: 0.3, opacity: 0.7 },
  { cx: 69.9, cy: 69.2, r: 1, opacity: 0.9 },
  { cx: 142.7, cy: 44.5, r: 0.3, opacity: 0.3 },
  { cx: 106.3, cy: 29.7, r: 0.9, opacity: 1 },
  { cx: 153.5, cy: 31.7, r: 0.3, opacity: 0.7 },
  { cx: 15.5, cy: 9.7, r: 0.4, opacity: 0.5 },
  { cx: 155.1, cy: 14.3, r: 0.3, opacity: 0.7 },
  { cx: 67, cy: 23.5, r: 0.3, opacity: 0.7 },
  { cx: 126, cy: 69.7, r: 0.5, opacity: 0.4 },
  { cx: 147.4, cy: 38.7, r: 0.6, opacity: 0.3 },
  { cx: 22.6, cy: 55, r: 0.5, opacity: 0.7 },
  { cx: 177.2, cy: 1.9, r: 0.3, opacity: 0.3 },
  { cx: 260.7, cy: 71.6, r: 0.6, opacity: 0.5 },
  { cx: 105.3, cy: 47.5, r: 0.5, opacity: 0.3 },
  { cx: 243.2, cy: 32, r: 0.3, opacity: 0.4 },
  { cx: 10.9, cy: 7.9, r: 0.3, opacity: 0.4 },
  { cx: 84.7, cy: 64.9, r: 0.4, opacity: 0.7 },
  { cx: 19.5, cy: 9.5, r: 0.6, opacity: 0.5 },
  { cx: 111.8, cy: 41.5, r: 0.3, opacity: 0.5 },
  { cx: 272.9, cy: 50.7, r: 0.3, opacity: 0.4 },
  { cx: 158.4, cy: 42.6, r: 0.4, opacity: 0.4 },
  { cx: 198.6, cy: 1.1, r: 0.5, opacity: 0.7 },
  { cx: 19.3, cy: 44.6, r: 0.6, opacity: 0.7 },
  { cx: 39, cy: 48, r: 0.4, opacity: 0.7 },
  { cx: 142.7, cy: 50.8, r: 0.5, opacity: 0.3 },
  { cx: 102.9, cy: 20.2, r: 0.4, opacity: 0.6 },
  { cx: 128, cy: 57.5, r: 0.3, opacity: 0.6 },
  { cx: 284, cy: 39.8, r: 0.3, opacity: 0.3 },
  { cx: 216.8, cy: 35.9, r: 0.3, opacity: 0.7 },
  { cx: 122.4, cy: 30.7, r: 0.4, opacity: 0.3 },
  { cx: 171.6, cy: 50.3, r: 0.3, opacity: 0.5 },
  { cx: 93.6, cy: 64.4, r: 0.3, opacity: 0.4 },
  { cx: 256.4, cy: 7.6, r: 0.3, opacity: 0.7 },
  { cx: 186.1, cy: 19.9, r: 0.3, opacity: 0.3 },
  { cx: 243.3, cy: 1.7, r: 0.3, opacity: 0.3 },
  { cx: 203.9, cy: 58.6, r: 0.5, opacity: 0.6 },
  { cx: 198.5, cy: 10.6, r: 0.3, opacity: 0.4 },
  { cx: 268.5, cy: 48.6, r: 0.3, opacity: 0.3 },
];

const METEOR_SHOWER_SPARKLES: ReadonlyArray<StageSparkle> = [
  { x: 100, y: 16 },
  { x: 196, y: 40 },
  { x: 262, y: 28 },
];

const METEORS: ReadonlyArray<{ x1: number; y1: number; x2: number; y2: number; opacity: number }> =
  [
    { x1: 356, y1: 6, x2: 304.0, y2: 36.0, opacity: 1 },
    { x1: 260, y1: 4, x2: 225.4, y2: 24.0, opacity: 0.8 },
    { x1: 180, y1: 14, x2: 155.8, y2: 28.0, opacity: 0.6 },
  ];

function MeteorShowerArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-meteor-sky`;
  const starsId = `${idPrefix}-stage-meteor-stars`;
  const meteorsId = `${idPrefix}-stage-meteor-trails`;
  const tailId = (index: number) => `${idPrefix}-stage-meteor-tail-${index}`;

  return (
    <svg
      data-stage-art="meteors"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <NightSkyGradient id={skyId} />
        <NightStarsPattern
          id={starsId}
          width={288}
          stars={METEOR_SHOWER_STARS}
          sparkles={METEOR_SHOWER_SPARKLES}
        />
        {METEORS.map((meteor, index) => (
          <linearGradient
            key={meteor.x1}
            id={tailId(index)}
            x1={meteor.x1}
            y1={meteor.y1}
            x2={meteor.x2}
            y2={meteor.y2}
            gradientUnits="userSpaceOnUse"
          >
            <stop style={{ stopColor: "var(--stage-night-line)" }} />
            <stop
              offset="0.25"
              style={{ stopColor: "var(--stage-meteor-tail)" }}
              stopOpacity="0.85"
            />
            <stop offset="1" style={{ stopColor: "var(--stage-meteor-tail)" }} stopOpacity="0" />
          </linearGradient>
        ))}
        <pattern id={meteorsId} width="384" height="96" patternUnits="userSpaceOnUse">
          {METEORS.map((meteor, index) => (
            <g key={meteor.x1} opacity={meteor.opacity}>
              <path
                d={`M${meteor.x1} ${meteor.y1}L${meteor.x2} ${meteor.y2}`}
                stroke={`url(#${tailId(index)})`}
                strokeLinecap="round"
                strokeWidth="1.25"
              />
              <circle
                cx={meteor.x1}
                cy={meteor.y1}
                r="1.05"
                style={{ fill: "var(--stage-night-line)" }}
              />
            </g>
          ))}
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />
      <rect width="100%" height="96" fill={`url(#${meteorsId})`} />
    </svg>
  );
}

function WireframeArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const paperId = `${idPrefix}-stage-wireframe-paper`;
  const glowId = `${idPrefix}-stage-wireframe-glow`;
  const dotsId = `${idPrefix}-stage-wireframe-dots`;
  const frameId = `${idPrefix}-stage-wireframe-frames`;

  return (
    <svg
      data-stage-art="wireframe"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: "var(--stage-wireframe-bottom)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-wireframe-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-wireframe-top)" }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-wireframe-highlight)" }} stopOpacity="0.4" />
          <stop offset="1" style={{ stopColor: "var(--stage-wireframe-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <pattern id={dotsId} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle
            cx="4"
            cy="4"
            r="0.5"
            style={{ fill: "var(--stage-wireframe-line)" }}
            fillOpacity="0.35"
          />
        </pattern>
        <pattern id={frameId} width="512" height="96" patternUnits="userSpaceOnUse">
          <rect width="512" height="96" fill={`url(#${glowId})`} />
          <g
            style={{ stroke: "var(--stage-wireframe-line)" }}
            strokeOpacity="0.7"
            strokeWidth="0.6"
            strokeDasharray="2 2"
          >
            <rect x="200" y="10" width="64" height="30" />
            <rect x="276" y="10" width="40" height="30" />
            <path d="M200 52H330" />
          </g>
          <g
            style={{ stroke: "var(--stage-wireframe-line)" }}
            strokeOpacity="0.6"
            strokeWidth="0.6"
          >
            <path d="M200 6V2M264 6V2M276 6V2M316 6V2" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${dotsId})`} />
      <rect width="100%" height="96" fill={`url(#${frameId})`} />
    </svg>
  );
}

const SLEIGH_STARS: ReadonlyArray<StageStar> = [
  { cx: 37.6, cy: 5.1, r: 0.47, opacity: 0.4 },
  { cx: 67.9, cy: 19.5, r: 0.49, opacity: 0.52 },
  { cx: 235.4, cy: 67.4, r: 0.44, opacity: 0.89 },
  { cx: 168.3, cy: 6, r: 0.37, opacity: 0.46 },
  { cx: 218.9, cy: 32.5, r: 0.38, opacity: 0.83 },
  { cx: 161.3, cy: 64.1, r: 0.47, opacity: 0.44 },
  { cx: 156.7, cy: 38.4, r: 0.48, opacity: 0.8 },
  { cx: 43.6, cy: 20.6, r: 0.63, opacity: 0.78 },
  { cx: 24.4, cy: 49.7, r: 0.52, opacity: 0.6 },
  { cx: 209.7, cy: 8.7, r: 0.52, opacity: 0.72 },
  { cx: 80.7, cy: 14.9, r: 0.46, opacity: 0.58 },
  { cx: 227.1, cy: 38.2, r: 0.5, opacity: 0.85 },
  { cx: 37.4, cy: 54.7, r: 0.49, opacity: 0.89 },
  { cx: 33, cy: 49.8, r: 0.37, opacity: 0.86 },
  { cx: 159.2, cy: 52.6, r: 0.58, opacity: 0.41 },
  { cx: 139.3, cy: 43.3, r: 0.5, opacity: 0.67 },
  { cx: 88.6, cy: 3.4, r: 0.61, opacity: 0.36 },
  { cx: 2, cy: 4.1, r: 0.55, opacity: 0.51 },
  { cx: 37.2, cy: 24.6, r: 0.45, opacity: 0.56 },
  { cx: 12, cy: 6.5, r: 0.39, opacity: 0.59 },
  { cx: 149.7, cy: 52.5, r: 0.48, opacity: 0.86 },
  { cx: 84.2, cy: 61.4, r: 0.61, opacity: 0.42 },
  { cx: 93.7, cy: 69.2, r: 0.56, opacity: 0.43 },
  { cx: 80.2, cy: 68.4, r: 0.56, opacity: 0.39 },
  { cx: 66.1, cy: 0.5, r: 0.53, opacity: 0.83 },
  { cx: 113.3, cy: 34.8, r: 0.38, opacity: 0.74 },
  { cx: 102.6, cy: 50.9, r: 0.56, opacity: 0.4 },
  { cx: 109.7, cy: 62, r: 0.5, opacity: 0.56 },
];

const SLEIGH_SPARKLES: ReadonlyArray<StageSparkle> = [
  { x: 44, y: 18 },
  { x: 150, y: 30 },
  { x: 206, y: 10 },
];

const SLEIGH_MOON_CRATERS: ReadonlyArray<{ cx: number; cy: number; r: number }> = [
  { cx: 268, cy: 24, r: 4.4 },
  { cx: 288, cy: 40, r: 3.2 },
  { cx: 284, cy: 20, r: 2.2 },
  { cx: 266, cy: 42, r: 2.6 },
  { cx: 295, cy: 28, r: 1.8 },
];

const SLEIGH_TRAIL_STARS: ReadonlyArray<{ x: number; y: number; size: number; opacity: number }> = [
  { x: 252, y: 41, size: 1.8, opacity: 0.85 },
  { x: 235.6, y: 46.8, size: 1.6, opacity: 0.71 },
  { x: 219.2, y: 48.9, size: 1.4, opacity: 0.57 },
  { x: 202.8, y: 49.9, size: 1.2, opacity: 0.43 },
  { x: 186.4, y: 54, size: 1, opacity: 0.29 },
  { x: 170, y: 60.4, size: 0.8, opacity: 0.15 },
];

const SLEIGH_TRAIL_DUST: ReadonlyArray<{ cx: number; cy: number; r: number; opacity: number }> = [
  { cx: 246.5, cy: 43.2, r: 0.58, opacity: 0.76 },
  { cx: 241.1, cy: 45.2, r: 0.56, opacity: 0.71 },
  { cx: 230.1, cy: 47.9, r: 0.52, opacity: 0.63 },
  { cx: 224.7, cy: 48.6, r: 0.5, opacity: 0.58 },
  { cx: 213.7, cy: 49.1, r: 0.46, opacity: 0.5 },
  { cx: 208.3, cy: 49.4, r: 0.44, opacity: 0.45 },
  { cx: 197.3, cy: 50.8, r: 0.4, opacity: 0.37 },
  { cx: 191.9, cy: 52.2, r: 0.38, opacity: 0.32 },
  { cx: 180.9, cy: 56.1, r: 0.34, opacity: 0.24 },
  { cx: 175.5, cy: 58.3, r: 0.32, opacity: 0.19 },
];

const SLEIGH_REINDEER: ReadonlyArray<{ x: number; y: number }> = [
  { x: 15, y: 0 },
  { x: 27, y: -0.6 },
  { x: 39, y: 0.4 },
  { x: 51, y: -0.4 },
];

function fourPointStarPath(x: number, y: number, size: number) {
  const pinch = size * 0.14;
  return `M${x} ${y - size}Q${x + pinch} ${y - pinch} ${x + size} ${y}Q${x + pinch} ${y + pinch} ${x} ${y + size}Q${x - pinch} ${y + pinch} ${x - size} ${y}Q${x - pinch} ${y - pinch} ${x} ${y - size}Z`;
}

function SleighRideArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-sleigh-sky`;
  const haloId = `${idPrefix}-stage-sleigh-halo`;
  const moonId = `${idPrefix}-stage-sleigh-moon`;
  const noseId = `${idPrefix}-stage-sleigh-nose`;
  const starsId = `${idPrefix}-stage-sleigh-stars`;

  return (
    <svg
      data-stage-art="sleigh"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "144 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <NightSkyGradient id={skyId} />
        <radialGradient
          id={haloId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(278 32) scale(72 64)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-sleigh-halo)" }} stopOpacity="0.34" />
          <stop
            offset="0.38"
            style={{ stopColor: "var(--stage-night-secondary)" }}
            stopOpacity="0.12"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-night-top)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={moonId} cx="0.42" cy="0.38" r="0.7">
          <stop style={{ stopColor: "var(--stage-sleigh-moon-highlight)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-sleigh-moon)" }} />
        </radialGradient>
        <radialGradient id={noseId}>
          <stop style={{ stopColor: "var(--stage-sleigh-nose)" }} stopOpacity="0.75" />
          <stop offset="1" style={{ stopColor: "var(--stage-sleigh-nose)" }} stopOpacity="0" />
        </radialGradient>
        <NightStarsPattern
          id={starsId}
          width={256}
          stars={SLEIGH_STARS}
          sparkles={SLEIGH_SPARKLES}
        />
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />
      <rect width="768" height="96" fill={`url(#${haloId})`} />

      <circle cx="278" cy="32" r="27" fill={`url(#${moonId})`} />
      <g style={{ fill: "var(--stage-sleigh-crater)" }} fillOpacity="0.32">
        {SLEIGH_MOON_CRATERS.map((crater) => (
          <circle key={`${crater.cx}-${crater.cy}`} cx={crater.cx} cy={crater.cy} r={crater.r} />
        ))}
      </g>

      <g
        transform="translate(253 41) rotate(-15) scale(0.78)"
        style={{ color: "var(--stage-sleigh-ink)" }}
        strokeLinecap="round"
      >
        <path
          d="M-0.5 0.2C0.8 0.2 1.4 1 1.8 2.2L8.4 2.2L9.8 0.4L11 0.4L9.8 4.6L1.8 4.6C0.4 4.6 -0.5 3.4 -0.5 2Z"
          fill="currentColor"
        />
        <circle cx="3" cy="0.9" r="1.9" fill="currentColor" />
        <path d="M5.6 2.4L6 -0.4C6.1 -1.1 7.2 -1.1 7.3 -0.4L7.6 2.4Z" fill="currentColor" />
        <circle cx="6.65" cy="-1.5" r="1" fill="currentColor" />
        <path
          d="M0 6H10.2C11.2 6 11.8 5.4 12.1 4.6M2.6 4.6V6M8 4.6V6"
          stroke="currentColor"
          strokeWidth="0.6"
        />
        <path d="M10.4 2.6C14 2.4 18 2.8 66 3.4" stroke="currentColor" strokeWidth="0.35" />
        {SLEIGH_REINDEER.map((reindeer) => (
          <g key={reindeer.x} transform={`translate(${reindeer.x} ${reindeer.y})`}>
            <path
              d="M0 3.2C0 2.2 1.2 1.8 2.5 2L6.2 2C6.9 2 7.4 1.4 7.8 0.9L8.4 0.3C8.8 -0.1 9.6 0 10.2 0.6L10.6 1.1C10.7 1.4 10.4 1.6 10.1 1.5L9.4 1.4C9 1.9 8.5 2.8 8.2 3.6C8 4.4 7.4 4.8 6.6 4.8L2.6 4.8C1.2 4.8 0 4.3 0 3.2Z"
              fill="currentColor"
            />
            <path
              d="M7.4 4.3L9.9 5.5M6.7 4.6L9 6.5M1.8 4.3L-1 5.1M2.6 4.6L-0.3 6.3M0.2 2.6L-0.8 2"
              stroke="currentColor"
              strokeWidth="0.65"
            />
            <path
              d="M8.7 0.4L8.2 -1.7M8.4 -0.7L7.5 -1.3M9.3 0.2L9.7 -1.8M9.55 -0.9L10.4 -1.4"
              stroke="currentColor"
              strokeWidth="0.45"
            />
          </g>
        ))}
        <circle cx="61.6" cy="0.8" r="3.2" fill={`url(#${noseId})`} />
        <circle cx="61.6" cy="0.8" r="0.75" style={{ fill: "var(--stage-sleigh-nose)" }} />
      </g>

      <g style={{ fill: "var(--stage-sleigh-dust)" }}>
        {SLEIGH_TRAIL_DUST.map((mote) => (
          <circle key={mote.cx} cx={mote.cx} cy={mote.cy} r={mote.r} fillOpacity={mote.opacity} />
        ))}
        {SLEIGH_TRAIL_STARS.map((star) => (
          <path
            key={star.x}
            d={fourPointStarPath(star.x, star.y, star.size)}
            fillOpacity={star.opacity}
          />
        ))}
      </g>
    </svg>
  );
}
