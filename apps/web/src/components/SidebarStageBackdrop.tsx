import { useAtomValue } from "@effect/atom-react";
import {
  fourPointStarPath,
  METEOR_SHOWER_METEOR_TILE_WIDTH,
  METEOR_SHOWER_METEORS,
  METEOR_SHOWER_SPARKLES,
  METEOR_SHOWER_STAR_TILE_WIDTH,
  METEOR_SHOWER_STARS,
  NIGHT_SKY_GRADIENT,
  resolveVisibleStageArtworkVariant,
  SLEIGH_HALO_TRANSFORM,
  SLEIGH_HALO_WIDTH,
  SLEIGH_MOON,
  SLEIGH_MOON_CRATERS,
  SLEIGH_REINDEER,
  SLEIGH_SHAPES,
  SLEIGH_SPARKLES,
  SLEIGH_STAR_TILE_WIDTH,
  SLEIGH_STARS,
  SLEIGH_TRAIL_DUST,
  SLEIGH_TRAIL_STARS,
  SLEIGH_TRANSFORM,
  sparklePath,
  STAGE_ARTWORK_HEIGHT,
  type StageArtworkVariant,
  type StageSparkle,
  type StageStar,
  WIREFRAME_DOT_SPACING,
  WIREFRAME_FRAMES,
  WIREFRAME_GLOW_TRANSFORM,
  WIREFRAME_GUIDE_PATH,
  WIREFRAME_PAPER_GRADIENT,
  WIREFRAME_TICKS_PATH,
  WIREFRAME_TILE_WIDTH,
} from "@supacode/client-runtime/stage-artwork";
import { type ComponentType, useId, useSyncExternalStore } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { useTheme } from "../hooks/useTheme";
import { primaryServerConfigAtom } from "../state/server";
import { getThemePreviewAppearance, subscribeToThemePreview } from "../themePalette";

const STAGE_BACKDROP_VIEW_BOX = `0 0 8192 ${STAGE_ARTWORK_HEIGHT}`;

export function useEnvironmentStageLabel(): string | null {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): StageArtworkVariant | null {
  const stageLabel = useEnvironmentStageLabel();
  const { resolvedTheme } = useTheme();
  const previewAppearance = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewAppearance,
    () => null,
  );
  return enabled
    ? resolveVisibleStageArtworkVariant(stageLabel, previewAppearance ?? resolvedTheme)
    : null;
}

/** Stage-channel header art; palettes mirror the per-channel app icons in `assets/`. */
export function SidebarStageBackdrop({ variant }: { variant: StageArtworkVariant }) {
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
  nightly: MeteorShowerArt,
  dev: WireframeArt,
  release: SleighRideArt,
} satisfies Record<StageArtworkVariant, ComponentType<{ compact?: boolean }>>;

export function StageBackdropArt({ variant }: { variant: StageArtworkVariant }) {
  const Art = STAGE_BACKDROP_ART[variant];
  return <Art />;
}

export function StageBackdropButtonArt({ variant }: { variant: StageArtworkVariant }) {
  const Art = STAGE_BACKDROP_ART[variant];
  return <Art compact />;
}

function NightSkyGradient({ id }: { id: string }) {
  return (
    <linearGradient
      id={id}
      {...NIGHT_SKY_GRADIENT}
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
    <pattern id={id} width={width} height={STAGE_ARTWORK_HEIGHT} patternUnits="userSpaceOnUse">
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
        {sparkles.map((sparkle) => (
          <path key={`${sparkle.x}-${sparkle.y}`} d={sparklePath(sparkle)} />
        ))}
      </g>
    </pattern>
  );
}

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
          width={METEOR_SHOWER_STAR_TILE_WIDTH}
          stars={METEOR_SHOWER_STARS}
          sparkles={METEOR_SHOWER_SPARKLES}
        />
        {METEOR_SHOWER_METEORS.map((meteor, index) => (
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
        <pattern
          id={meteorsId}
          width={METEOR_SHOWER_METEOR_TILE_WIDTH}
          height={STAGE_ARTWORK_HEIGHT}
          patternUnits="userSpaceOnUse"
        >
          {METEOR_SHOWER_METEORS.map((meteor, index) => (
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

      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${skyId})`} />
      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${starsId})`} />
      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${meteorsId})`} />
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
          {...WIREFRAME_PAPER_GRADIENT}
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
          gradientTransform={WIREFRAME_GLOW_TRANSFORM}
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-wireframe-highlight)" }} stopOpacity="0.4" />
          <stop offset="1" style={{ stopColor: "var(--stage-wireframe-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <pattern
          id={dotsId}
          width={WIREFRAME_DOT_SPACING}
          height={WIREFRAME_DOT_SPACING}
          patternUnits="userSpaceOnUse"
        >
          <circle
            cx="4"
            cy="4"
            r="0.5"
            style={{ fill: "var(--stage-wireframe-line)" }}
            fillOpacity="0.35"
          />
        </pattern>
        <pattern
          id={frameId}
          width={WIREFRAME_TILE_WIDTH}
          height={STAGE_ARTWORK_HEIGHT}
          patternUnits="userSpaceOnUse"
        >
          <rect
            width={WIREFRAME_TILE_WIDTH}
            height={STAGE_ARTWORK_HEIGHT}
            fill={`url(#${glowId})`}
          />
          <g
            style={{ stroke: "var(--stage-wireframe-line)" }}
            strokeOpacity="0.7"
            strokeWidth="0.6"
            strokeDasharray="2 2"
          >
            {WIREFRAME_FRAMES.map((frame) => (
              <rect key={frame.x} {...frame} />
            ))}
            <path d={WIREFRAME_GUIDE_PATH} />
          </g>
          <g
            style={{ stroke: "var(--stage-wireframe-line)" }}
            strokeOpacity="0.6"
            strokeWidth="0.6"
          >
            <path d={WIREFRAME_TICKS_PATH} />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${paperId})`} />
      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${dotsId})`} />
      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${frameId})`} />
    </svg>
  );
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
          gradientTransform={SLEIGH_HALO_TRANSFORM}
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
          width={SLEIGH_STAR_TILE_WIDTH}
          stars={SLEIGH_STARS}
          sparkles={SLEIGH_SPARKLES}
        />
      </defs>

      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${skyId})`} />
      <rect width="100%" height={STAGE_ARTWORK_HEIGHT} fill={`url(#${starsId})`} />
      <rect width={SLEIGH_HALO_WIDTH} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${haloId})`} />

      <circle {...SLEIGH_MOON} fill={`url(#${moonId})`} />
      <g style={{ fill: "var(--stage-sleigh-crater)" }} fillOpacity="0.32">
        {SLEIGH_MOON_CRATERS.map((crater) => (
          <circle key={`${crater.cx}-${crater.cy}`} cx={crater.cx} cy={crater.cy} r={crater.r} />
        ))}
      </g>

      <g
        transform={SLEIGH_TRANSFORM}
        style={{ color: "var(--stage-sleigh-ink)" }}
        strokeLinecap="round"
      >
        <path d={SLEIGH_SHAPES.sleighPath} fill="currentColor" />
        <circle {...SLEIGH_SHAPES.sackCircle} fill="currentColor" />
        <path d={SLEIGH_SHAPES.riderPath} fill="currentColor" />
        <circle {...SLEIGH_SHAPES.riderHeadCircle} fill="currentColor" />
        <path d={SLEIGH_SHAPES.runnersPath} stroke="currentColor" strokeWidth="0.6" />
        <path d={SLEIGH_SHAPES.reinsPath} stroke="currentColor" strokeWidth="0.35" />
        {SLEIGH_REINDEER.map((reindeer) => (
          <g key={reindeer.x} transform={`translate(${reindeer.x} ${reindeer.y})`}>
            <path d={SLEIGH_SHAPES.reindeerBodyPath} fill="currentColor" />
            <path d={SLEIGH_SHAPES.reindeerLegsPath} stroke="currentColor" strokeWidth="0.65" />
            <path d={SLEIGH_SHAPES.reindeerAntlersPath} stroke="currentColor" strokeWidth="0.45" />
          </g>
        ))}
        <circle
          cx={SLEIGH_SHAPES.nose.cx}
          cy={SLEIGH_SHAPES.nose.cy}
          r={SLEIGH_SHAPES.nose.glowR}
          fill={`url(#${noseId})`}
        />
        <circle
          cx={SLEIGH_SHAPES.nose.cx}
          cy={SLEIGH_SHAPES.nose.cy}
          r={SLEIGH_SHAPES.nose.r}
          style={{ fill: "var(--stage-sleigh-nose)" }}
        />
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
