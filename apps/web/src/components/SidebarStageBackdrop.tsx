import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@supacode/contracts";
import { type ComponentType, useId, useSyncExternalStore } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { useTheme } from "../hooks/useTheme";
import { primaryServerConfigAtom } from "../state/server";
import {
  getThemePreviewAppearance,
  subscribeToThemePreview,
  type ThemeAppearance,
} from "../themePalette";

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

/** Dev and nightly keep their artwork in every theme; release only shows the sleigh when dark. */
export function resolveVisibleSidebarStageBackdropVariant(
  stageLabel: string | null,
  appearance: ThemeAppearance,
): SidebarStageBackdropVariant | null {
  const variant = resolveSidebarStageBackdropVariant(stageLabel);
  if (variant === "release" && appearance !== "dark") return null;
  return variant;
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
  const { resolvedTheme } = useTheme();
  const previewAppearance = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewAppearance,
    () => null,
  );
  return enabled
    ? resolveVisibleSidebarStageBackdropVariant(stageLabel, previewAppearance ?? resolvedTheme)
    : null;
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
  nightly: StarfieldArt,
  dev: CautionTapeArt,
  release: SleighRideArt,
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

const STARFIELD_STARS: ReadonlyArray<StageStar> = [
  { cx: 129, cy: 27.3, r: 0.9, opacity: 0.9 },
  { cx: 56, cy: 27.2, r: 0.9, opacity: 0.9 },
  { cx: 269.3, cy: 56.1, r: 0.8, opacity: 0.9 },
  { cx: 218.7, cy: 0.7, r: 0.7, opacity: 0.9 },
  { cx: 122.5, cy: 59.6, r: 0.7, opacity: 0.9 },
  { cx: 73.5, cy: 49.4, r: 0.8, opacity: 1 },
  { cx: 187.2, cy: 58.4, r: 0.8, opacity: 0.9 },
  { cx: 14.5, cy: 41.5, r: 0.8, opacity: 0.9 },
  { cx: 169.3, cy: 18.6, r: 0.3, opacity: 0.7 },
  { cx: 163, cy: 49.8, r: 0.5, opacity: 0.6 },
  { cx: 85.9, cy: 30.6, r: 0.4, opacity: 0.3 },
  { cx: 115.2, cy: 47.3, r: 0.5, opacity: 0.4 },
  { cx: 115.6, cy: 6, r: 0.4, opacity: 0.3 },
  { cx: 113.7, cy: 31.6, r: 0.3, opacity: 0.5 },
  { cx: 140.4, cy: 22.4, r: 0.5, opacity: 0.7 },
  { cx: 114.9, cy: 34.7, r: 0.4, opacity: 0.5 },
  { cx: 207.9, cy: 17.2, r: 0.4, opacity: 0.4 },
  { cx: 222.9, cy: 63.9, r: 0.4, opacity: 0.3 },
  { cx: 59.4, cy: 35, r: 0.4, opacity: 0.7 },
  { cx: 155.7, cy: 0.3, r: 0.6, opacity: 0.5 },
  { cx: 139.5, cy: 61.7, r: 0.3, opacity: 0.5 },
  { cx: 259.6, cy: 55, r: 0.4, opacity: 0.4 },
  { cx: 85.2, cy: 35, r: 0.6, opacity: 0.6 },
  { cx: 106.4, cy: 36.9, r: 0.3, opacity: 0.3 },
  { cx: 80.7, cy: 28.5, r: 0.5, opacity: 0.6 },
  { cx: 26.6, cy: 0.3, r: 0.5, opacity: 0.7 },
  { cx: 225.8, cy: 21.7, r: 0.6, opacity: 0.5 },
  { cx: 158.3, cy: 55.8, r: 0.3, opacity: 0.4 },
  { cx: 246.1, cy: 30.9, r: 0.6, opacity: 0.6 },
  { cx: 12.3, cy: 11.7, r: 0.5, opacity: 0.7 },
  { cx: 230.9, cy: 32.7, r: 0.3, opacity: 0.5 },
  { cx: 128.3, cy: 35.7, r: 0.3, opacity: 0.7 },
  { cx: 125.9, cy: 45.3, r: 0.6, opacity: 0.7 },
  { cx: 49.3, cy: 15.1, r: 0.4, opacity: 0.6 },
  { cx: 239, cy: 60.3, r: 0.3, opacity: 0.6 },
  { cx: 220, cy: 51.1, r: 0.3, opacity: 0.4 },
  { cx: 205.5, cy: 10.2, r: 0.4, opacity: 0.7 },
  { cx: 247.6, cy: 44.2, r: 0.4, opacity: 0.5 },
  { cx: 214.9, cy: 6, r: 0.4, opacity: 0.6 },
  { cx: 224.7, cy: 58.2, r: 0.4, opacity: 0.5 },
  { cx: 208.1, cy: 55.5, r: 0.6, opacity: 0.5 },
  { cx: 28.2, cy: 56.2, r: 0.4, opacity: 0.4 },
  { cx: 167.4, cy: 33.7, r: 0.6, opacity: 0.5 },
  { cx: 148.6, cy: 46.2, r: 0.3, opacity: 0.3 },
  { cx: 62, cy: 3.1, r: 0.6, opacity: 0.5 },
  { cx: 185.6, cy: 19.7, r: 0.4, opacity: 0.4 },
  { cx: 21.1, cy: 3, r: 0.3, opacity: 0.7 },
  { cx: 51.2, cy: 46.2, r: 0.6, opacity: 0.3 },
  { cx: 205.6, cy: 55.8, r: 0.3, opacity: 0.5 },
  { cx: 264, cy: 5.4, r: 0.3, opacity: 0.3 },
  { cx: 200.1, cy: 51.3, r: 0.4, opacity: 0.5 },
  { cx: 117.4, cy: 37.7, r: 0.5, opacity: 0.6 },
  { cx: 13.8, cy: 33.3, r: 0.4, opacity: 0.6 },
  { cx: 0.6, cy: 22.7, r: 0.4, opacity: 0.6 },
  { cx: 6.6, cy: 18.3, r: 0.3, opacity: 0.4 },
  { cx: 50.1, cy: 28.4, r: 0.6, opacity: 0.6 },
  { cx: 112.6, cy: 29.8, r: 0.3, opacity: 0.5 },
  { cx: 133.3, cy: 9.3, r: 0.4, opacity: 0.5 },
  { cx: 154.8, cy: 23.3, r: 0.4, opacity: 0.4 },
  { cx: 235.3, cy: 51.1, r: 0.6, opacity: 0.5 },
  { cx: 287.4, cy: 62.9, r: 0.4, opacity: 0.6 },
  { cx: 76.1, cy: 24.7, r: 0.6, opacity: 0.5 },
  { cx: 222.5, cy: 14.6, r: 0.6, opacity: 0.5 },
  { cx: 9.8, cy: 6.7, r: 0.4, opacity: 0.6 },
];

const STARFIELD_SPARKLES: ReadonlyArray<StageSparkle> = [
  { x: 96, y: 16 },
  { x: 178, y: 40 },
  { x: 262, y: 22 },
];

function StarfieldArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-starfield-sky`;
  const starsId = `${idPrefix}-stage-starfield-stars`;

  return (
    <svg
      data-stage-art="starfield"
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
          stars={STARFIELD_STARS}
          sparkles={STARFIELD_SPARKLES}
        />
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />
    </svg>
  );
}

function CautionTapeArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const baseId = `${idPrefix}-stage-caution-base`;
  const stripesId = `${idPrefix}-stage-caution-stripes`;

  return (
    <svg
      data-stage-art="caution"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={baseId} x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--stage-caution-top)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-caution-bottom)" }} />
        </linearGradient>
        <pattern
          id={stripesId}
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="14" height="14" style={{ fill: "var(--stage-caution-ink)" }} />
          <rect width="7" height="14" style={{ fill: "var(--stage-caution-stripe)" }} />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${baseId})`} />
      <rect width="100%" height="9" fill={`url(#${stripesId})`} />
      <rect
        y="9"
        width="100%"
        height="0.8"
        style={{ fill: "var(--stage-caution-ink)" }}
        fillOpacity="0.5"
      />
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
