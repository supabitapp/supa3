import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@supacode/contracts";
import type { ThemeAppearance } from "@supacode/shared/themePalettes";
import { type ComponentType, useId } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { useTheme } from "../hooks/useTheme";
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

/** The release sleigh is a night scene, so it only renders under dark themes. */
export function resolveVisibleStageBackdropVariant(
  stageLabel: string | null,
  appearance: ThemeAppearance,
): SidebarStageBackdropVariant | null {
  const variant = resolveSidebarStageBackdropVariant(stageLabel);
  return variant === "release" && appearance !== "dark" ? null : variant;
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
  return enabled ? resolveVisibleStageBackdropVariant(stageLabel, resolvedTheme) : null;
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
  nightly: NightlySkyArt,
  dev: DevBlueprintArt,
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

const NIGHTLY_STARS: ReadonlyArray<StageStar> = [
  { cx: 14, cy: 10, r: 0.6, opacity: 0.85 },
  { cx: 38, cy: 22, r: 0.4, opacity: 0.55 },
  { cx: 58, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 84, cy: 16, r: 0.4, opacity: 0.5 },
  { cx: 104, cy: 7, r: 0.6, opacity: 0.8 },
  { cx: 126, cy: 20, r: 0.4, opacity: 0.55 },
  { cx: 148, cy: 11, r: 0.5, opacity: 0.7 },
  { cx: 170, cy: 24, r: 0.4, opacity: 0.5 },
  { cx: 192, cy: 9, r: 0.6, opacity: 0.8 },
  { cx: 214, cy: 18, r: 0.4, opacity: 0.55 },
  { cx: 236, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 258, cy: 20, r: 0.45, opacity: 0.6 },
  { cx: 278, cy: 11, r: 0.55, opacity: 0.75 },
  { cx: 26, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 118, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 202, cy: 32, r: 0.4, opacity: 0.5 },
  { cx: 268, cy: 34, r: 0.4, opacity: 0.45 },
];

const NIGHTLY_SPARKLES: ReadonlyArray<StageSparkle> = [
  { x: 70, y: 28 },
  { x: 160, y: 36 },
  { x: 246, y: 26 },
];

function NightlySkyArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-night-sky`;
  const glowId = `${idPrefix}-stage-night-glow`;
  const cloudId = `${idPrefix}-stage-night-cloud`;
  const softId = `${idPrefix}-stage-night-soft`;
  const starsId = `${idPrefix}-stage-night-stars`;
  const glowsId = `${idPrefix}-stage-night-glows`;

  return (
    <svg
      data-stage-art="nightly"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <NightSkyGradient id={skyId} />
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 18) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-night-glow-highlight)" }} stopOpacity="0.4" />
          <stop
            offset="0.5"
            style={{ stopColor: "var(--stage-night-glow-secondary)" }}
            stopOpacity="0.16"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-night-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={cloudId} x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--stage-night-highlight)" }} stopOpacity="0.5" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-night-secondary)" }}
            stopOpacity="0.62"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-night-tertiary)" }} stopOpacity="0.5" />
        </linearGradient>
        <filter id={softId} x="-24" y="-24" width="336" height="144" filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <NightStarsPattern
          id={starsId}
          width={288}
          stars={NIGHTLY_STARS}
          sparkles={NIGHTLY_SPARKLES}
        />
        <pattern id={glowsId} width="640" height="96" patternUnits="userSpaceOnUse">
          <rect width="640" height="96" fill={`url(#${glowId})`} />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />

      <g filter={`url(#${softId})`}>
        <path
          d="M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82C132 83 138 88 141 96H-12V88Z"
          fill={`url(#${cloudId})`}
        />
      </g>
      <g filter={`url(#${softId})`}>
        <path
          d="M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87C250 87 257 91 260 96H150Z"
          fill={`url(#${cloudId})`}
          fillOpacity="0.8"
        />
      </g>
    </svg>
  );
}

function DevBlueprintArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const paperId = `${idPrefix}-stage-bp-paper`;
  const glowId = `${idPrefix}-stage-bp-glow`;
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`;
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`;
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`;
  const majorGridId = `${idPrefix}-stage-bp-grid-major`;
  const rulerId = `${idPrefix}-stage-bp-ruler`;
  const glowsId = `${idPrefix}-stage-bp-glows`;
  const annotationsId = `${idPrefix}-stage-bp-annotations`;

  return (
    <svg
      data-stage-art="blueprint"
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
          <stop style={{ stopColor: "var(--stage-art-bottom)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-art-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-art-top)" }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-highlight)" }} stopOpacity="0.4" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-art-secondary)" }}
            stopOpacity="0.16"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={celesteGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-celeste-highlight)" }} stopOpacity="0.34" />
          <stop
            offset="0.5"
            style={{ stopColor: "var(--stage-art-celeste-secondary)" }}
            stopOpacity="0.18"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={violetGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-violet-highlight)" }} stopOpacity="0.3" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-art-tertiary)" }}
            stopOpacity="0.14"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path
            d="M8 0H0V8"
            style={{ stroke: "var(--stage-art-grid-line)" }}
            strokeOpacity="0.14"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path
            d="M32 0H0V32"
            style={{ stroke: "var(--stage-art-grid-line)" }}
            strokeOpacity="0.26"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            style={{ stroke: "var(--stage-art-line)" }}
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${celesteGlowId})`} />
          <rect width="768" height="96" fill={`url(#${violetGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g
            style={{ stroke: "var(--stage-art-line)" }}
            strokeLinecap="round"
            strokeOpacity="0.6"
            strokeWidth="0.7"
          >
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g
            style={{ stroke: "var(--stage-art-line)" }}
            strokeLinecap="round"
            strokeOpacity="0.55"
            strokeWidth="0.6"
          >
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g style={{ stroke: "var(--stage-art-line)" }} strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
      <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
      <rect width="100%" height="6" fill={`url(#${rulerId})`} />
      <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
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
  { cx: 252, cy: 24, r: 4.4 },
  { cx: 272, cy: 40, r: 3.2 },
  { cx: 268, cy: 20, r: 2.2 },
  { cx: 250, cy: 42, r: 2.6 },
  { cx: 279, cy: 28, r: 1.8 },
];

const SLEIGH_TRAIL_STARS: ReadonlyArray<{ x: number; y: number; size: number; opacity: number }> = [
  { x: 236, y: 41, size: 1.8, opacity: 0.85 },
  { x: 219.6, y: 46.8, size: 1.6, opacity: 0.71 },
  { x: 203.2, y: 48.9, size: 1.4, opacity: 0.57 },
  { x: 186.8, y: 49.9, size: 1.2, opacity: 0.43 },
  { x: 170.4, y: 54, size: 1, opacity: 0.29 },
  { x: 154, y: 60.4, size: 0.8, opacity: 0.15 },
];

const SLEIGH_TRAIL_DUST: ReadonlyArray<{ cx: number; cy: number; r: number; opacity: number }> = [
  { cx: 230.5, cy: 43.2, r: 0.58, opacity: 0.76 },
  { cx: 225.1, cy: 45.2, r: 0.56, opacity: 0.71 },
  { cx: 214.1, cy: 47.9, r: 0.52, opacity: 0.63 },
  { cx: 208.7, cy: 48.6, r: 0.5, opacity: 0.58 },
  { cx: 197.7, cy: 49.1, r: 0.46, opacity: 0.5 },
  { cx: 192.3, cy: 49.4, r: 0.44, opacity: 0.45 },
  { cx: 181.3, cy: 50.8, r: 0.4, opacity: 0.37 },
  { cx: 175.9, cy: 52.2, r: 0.38, opacity: 0.32 },
  { cx: 164.9, cy: 56.1, r: 0.34, opacity: 0.24 },
  { cx: 159.5, cy: 58.3, r: 0.32, opacity: 0.19 },
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
      viewBox={compact ? "128 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <NightSkyGradient id={skyId} />
        <radialGradient
          id={haloId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(262 32) scale(72 64)"
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

      <circle cx="262" cy="32" r="27" fill={`url(#${moonId})`} />
      <g style={{ fill: "var(--stage-sleigh-crater)" }} fillOpacity="0.32">
        {SLEIGH_MOON_CRATERS.map((crater) => (
          <circle key={`${crater.cx}-${crater.cy}`} cx={crater.cx} cy={crater.cy} r={crater.r} />
        ))}
      </g>

      <g
        transform="translate(237 41) rotate(-15) scale(0.78)"
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
