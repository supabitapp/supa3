import {
  fourPointStarPath,
  type GradientVector,
  METEOR_SHOWER_METEOR_TILE_WIDTH,
  METEOR_SHOWER_METEORS,
  METEOR_SHOWER_SPARKLES,
  METEOR_SHOWER_STAR_TILE_WIDTH,
  METEOR_SHOWER_STARS,
  NIGHT_SKY_GRADIENT,
  reflectedGradient,
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
import type { ThemeAppearance } from "@supacode/shared/themePalettes";
import { type ComponentType, memo, useId, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Pattern,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "../lib/useUniwindTheme";

// The untinted `:root` stage palette from apps/web/src/index.css, converted to sRGB for
// react-native-svg. Mobile does not apply the web themes' per-theme sky tints.
const NIGHT_COLORS = {
  top: "#32155B",
  mid: "#151443",
  bottom: "#07152F",
  secondary: "#696FEA",
  line: "#E4EAFF",
  sparkle: "#C8D7FF",
  meteorTail: "#C4B6F6",
} as const;

const WIREFRAME_COLORS = {
  light: { top: "#67C2FF", mid: "#347FF8", bottom: "#1538D0" },
  dark: { top: "#3A7AD1", mid: "#2050AE", bottom: "#101F6E" },
  highlight: "#D4F6FF",
  line: "#DDF7FF",
} as const;

const SLEIGH_COLORS = {
  halo: "#E8D7A3",
  moonHighlight: "#FFFCED",
  moon: "#E5D6B6",
  crater: "#CBBBA1",
  ink: "#060E25",
  nose: "#FF2C29",
  dust: "#FFE196",
} as const;

// The curve of the web `sidebar-stage-backdrop` fade, as positions within the fade. Web also
// masks the art to transparent; mobile ends on the opaque surface color instead.
const FADE_STOPS = [
  [0, 0],
  [0.18, 0.1],
  [0.37, 0.3],
  [0.55, 0.58],
  [0.72, 0.82],
  [0.88, 0.96],
  [1, 1],
] as const;

/**
 * Fills its parent with the stage art. The bottom `fadeLength` points fade into the `fadeTo`
 * theme color so the art blends into the surface below the header.
 */
export const StageArtworkBackdrop = memo(function StageArtworkBackdrop(props: {
  readonly variant: StageArtworkVariant;
  readonly fadeTo: "--color-screen" | "--color-header" | "--color-drawer";
  readonly fadeLength: number;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const fadeColor = useUniwindTheme()[props.fadeTo];
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const fadeId = `${useSvgId()}-fade`;
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current?.width === width && current.height === height ? current : { width, height },
    );
  };
  const Art = STAGE_ARTWORK[props.variant];

  if (!size || size.height <= 0) {
    return <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout} />;
  }
  const units = (size.width * STAGE_ARTWORK_HEIGHT) / size.height;
  const fadeStart = Math.max(0, 1 - props.fadeLength / size.height);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <Svg width={size.width} height={size.height} viewBox={`0 0 ${units} ${STAGE_ARTWORK_HEIGHT}`}>
        <Art units={units} appearance={themeAppearance} />
        <Defs>
          <LinearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
            {FADE_STOPS.map(([position, opacity]) => (
              <Stop
                key={position}
                offset={fadeStart + (1 - fadeStart) * position}
                stopColor={fadeColor}
                stopOpacity={opacity}
              />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${fadeId})`} />
      </Svg>
    </View>
  );
});

interface ArtProps {
  readonly units: number;
  readonly appearance: ThemeAppearance;
}

const STAGE_ARTWORK = {
  nightly: MeteorShowerArt,
  dev: WireframeArt,
  release: SleighRideArt,
} satisfies Record<StageArtworkVariant, ComponentType<ArtProps>>;

function useSvgId() {
  return useId().replaceAll(":", "");
}

function tileOffsets(units: number, tileWidth: number): number[] {
  return Array.from({ length: Math.ceil(units / tileWidth) }, (_, index) => index * tileWidth);
}

function ReflectedGradient(props: {
  readonly id: string;
  readonly vector: GradientVector;
  readonly units: number;
  readonly colors: { readonly from: string; readonly via: string; readonly to: string };
}) {
  const { stops, ...vector } = reflectedGradient(props.vector, props.units);
  return (
    <LinearGradient id={props.id} {...vector} gradientUnits="userSpaceOnUse">
      {stops.map((stop) => (
        <Stop key={stop.offset} offset={stop.offset} stopColor={props.colors[stop.color]} />
      ))}
    </LinearGradient>
  );
}

function NightStarsPattern(props: {
  readonly id: string;
  readonly tileWidth: number;
  readonly stars: ReadonlyArray<StageStar>;
  readonly sparkles: ReadonlyArray<StageSparkle>;
}) {
  return (
    <Pattern
      id={props.id}
      width={props.tileWidth}
      height={STAGE_ARTWORK_HEIGHT}
      patternUnits="userSpaceOnUse"
    >
      {props.stars.map((star) => (
        <Circle
          key={`${star.cx}-${star.cy}`}
          cx={star.cx}
          cy={star.cy}
          r={star.r}
          fill={NIGHT_COLORS.line}
          fillOpacity={star.opacity}
        />
      ))}
      {props.sparkles.map((sparkle) => (
        <Path
          key={`${sparkle.x}-${sparkle.y}`}
          d={sparklePath(sparkle)}
          fill="none"
          stroke={NIGHT_COLORS.sparkle}
          strokeLinecap="round"
          strokeOpacity={0.7}
          strokeWidth={0.6}
        />
      ))}
    </Pattern>
  );
}

const NIGHT_SKY_COLORS = {
  from: NIGHT_COLORS.bottom,
  via: NIGHT_COLORS.mid,
  to: NIGHT_COLORS.top,
} as const;

function MeteorShowerArt({ units }: ArtProps) {
  const prefix = useSvgId();
  const skyId = `${prefix}-sky`;
  const starsId = `${prefix}-stars`;
  const tailId = (index: number) => `${prefix}-tail-${index}`;

  return (
    <>
      <Defs>
        <ReflectedGradient
          id={skyId}
          vector={NIGHT_SKY_GRADIENT}
          units={units}
          colors={NIGHT_SKY_COLORS}
        />
        <NightStarsPattern
          id={starsId}
          tileWidth={METEOR_SHOWER_STAR_TILE_WIDTH}
          stars={METEOR_SHOWER_STARS}
          sparkles={METEOR_SHOWER_SPARKLES}
        />
        {METEOR_SHOWER_METEORS.map((meteor, index) => (
          <LinearGradient
            key={meteor.x1}
            id={tailId(index)}
            x1={meteor.x1}
            y1={meteor.y1}
            x2={meteor.x2}
            y2={meteor.y2}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset={0} stopColor={NIGHT_COLORS.line} />
            <Stop offset={0.25} stopColor={NIGHT_COLORS.meteorTail} stopOpacity={0.85} />
            <Stop offset={1} stopColor={NIGHT_COLORS.meteorTail} stopOpacity={0} />
          </LinearGradient>
        ))}
      </Defs>
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${skyId})`} />
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${starsId})`} />
      {/* Three meteors per tile: cheaper as groups than as a pattern of gradients. */}
      {tileOffsets(units, METEOR_SHOWER_METEOR_TILE_WIDTH).map((offset) => (
        <G key={offset} x={offset}>
          {METEOR_SHOWER_METEORS.map((meteor, index) => (
            <G key={meteor.x1} opacity={meteor.opacity}>
              <Path
                d={`M${meteor.x1} ${meteor.y1}L${meteor.x2} ${meteor.y2}`}
                fill="none"
                stroke={`url(#${tailId(index)})`}
                strokeLinecap="round"
                strokeWidth={1.25}
              />
              <Circle cx={meteor.x1} cy={meteor.y1} r={1.05} fill={NIGHT_COLORS.line} />
            </G>
          ))}
        </G>
      ))}
    </>
  );
}

function WireframeArt({ units, appearance }: ArtProps) {
  const prefix = useSvgId();
  const paperId = `${prefix}-paper`;
  const glowId = `${prefix}-glow`;
  const dotsId = `${prefix}-dots`;
  const paper = WIREFRAME_COLORS[appearance];

  return (
    <>
      <Defs>
        <ReflectedGradient
          id={paperId}
          vector={WIREFRAME_PAPER_GRADIENT}
          units={units}
          colors={{ from: paper.bottom, via: paper.mid, to: paper.top }}
        />
        <RadialGradient
          id={glowId}
          cx={0}
          cy={0}
          r={1}
          gradientTransform={WIREFRAME_GLOW_TRANSFORM}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset={0} stopColor={WIREFRAME_COLORS.highlight} stopOpacity={0.4} />
          <Stop offset={1} stopColor={paper.bottom} stopOpacity={0} />
        </RadialGradient>
        <Pattern
          id={dotsId}
          width={WIREFRAME_DOT_SPACING}
          height={WIREFRAME_DOT_SPACING}
          patternUnits="userSpaceOnUse"
        >
          <Circle
            cx={WIREFRAME_DOT_SPACING / 2}
            cy={WIREFRAME_DOT_SPACING / 2}
            r={0.5}
            fill={WIREFRAME_COLORS.line}
            fillOpacity={0.35}
          />
        </Pattern>
      </Defs>
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${paperId})`} />
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${dotsId})`} />
      {tileOffsets(units, WIREFRAME_TILE_WIDTH).map((offset) => (
        <G key={offset} x={offset}>
          <Rect
            width={WIREFRAME_TILE_WIDTH}
            height={STAGE_ARTWORK_HEIGHT}
            fill={`url(#${glowId})`}
          />
          <G
            fill="none"
            stroke={WIREFRAME_COLORS.line}
            strokeOpacity={0.7}
            strokeWidth={0.6}
            strokeDasharray="2 2"
          >
            {WIREFRAME_FRAMES.map((frame) => (
              <Rect key={frame.x} {...frame} />
            ))}
            <Path d={WIREFRAME_GUIDE_PATH} />
          </G>
          <Path
            d={WIREFRAME_TICKS_PATH}
            fill="none"
            stroke={WIREFRAME_COLORS.line}
            strokeOpacity={0.6}
            strokeWidth={0.6}
          />
        </G>
      ))}
    </>
  );
}

function SleighRideArt({ units }: ArtProps) {
  const prefix = useSvgId();
  const skyId = `${prefix}-sky`;
  const starsId = `${prefix}-stars`;
  const haloId = `${prefix}-halo`;
  const moonId = `${prefix}-moon`;
  const noseId = `${prefix}-nose`;
  const shapes = SLEIGH_SHAPES;

  return (
    <>
      <Defs>
        <ReflectedGradient
          id={skyId}
          vector={NIGHT_SKY_GRADIENT}
          units={units}
          colors={NIGHT_SKY_COLORS}
        />
        <NightStarsPattern
          id={starsId}
          tileWidth={SLEIGH_STAR_TILE_WIDTH}
          stars={SLEIGH_STARS}
          sparkles={SLEIGH_SPARKLES}
        />
        <RadialGradient
          id={haloId}
          cx={0}
          cy={0}
          r={1}
          gradientTransform={SLEIGH_HALO_TRANSFORM}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset={0} stopColor={SLEIGH_COLORS.halo} stopOpacity={0.34} />
          <Stop offset={0.38} stopColor={NIGHT_COLORS.secondary} stopOpacity={0.12} />
          <Stop offset={1} stopColor={NIGHT_COLORS.top} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={moonId} cx="0.42" cy="0.38" r="0.7">
          <Stop offset={0} stopColor={SLEIGH_COLORS.moonHighlight} />
          <Stop offset={1} stopColor={SLEIGH_COLORS.moon} />
        </RadialGradient>
        <RadialGradient id={noseId}>
          <Stop offset={0} stopColor={SLEIGH_COLORS.nose} stopOpacity={0.75} />
          <Stop offset={1} stopColor={SLEIGH_COLORS.nose} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${skyId})`} />
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${starsId})`} />
      <Rect width={SLEIGH_HALO_WIDTH} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${haloId})`} />
      <Circle {...SLEIGH_MOON} fill={`url(#${moonId})`} />
      {SLEIGH_MOON_CRATERS.map((crater) => (
        <Circle
          key={`${crater.cx}-${crater.cy}`}
          {...crater}
          fill={SLEIGH_COLORS.crater}
          fillOpacity={0.32}
        />
      ))}
      <G transform={SLEIGH_TRANSFORM}>
        <Path d={shapes.sleighPath} fill={SLEIGH_COLORS.ink} />
        <Circle {...shapes.sackCircle} fill={SLEIGH_COLORS.ink} />
        <Path d={shapes.riderPath} fill={SLEIGH_COLORS.ink} />
        <Circle {...shapes.riderHeadCircle} fill={SLEIGH_COLORS.ink} />
        <Path
          d={shapes.runnersPath}
          fill="none"
          stroke={SLEIGH_COLORS.ink}
          strokeWidth={0.6}
          strokeLinecap="round"
        />
        <Path
          d={shapes.reinsPath}
          fill="none"
          stroke={SLEIGH_COLORS.ink}
          strokeWidth={0.35}
          strokeLinecap="round"
        />
        {SLEIGH_REINDEER.map((reindeer) => (
          <G key={reindeer.x} x={reindeer.x} y={reindeer.y}>
            <Path d={shapes.reindeerBodyPath} fill={SLEIGH_COLORS.ink} />
            <Path
              d={shapes.reindeerLegsPath}
              fill="none"
              stroke={SLEIGH_COLORS.ink}
              strokeWidth={0.65}
              strokeLinecap="round"
            />
            <Path
              d={shapes.reindeerAntlersPath}
              fill="none"
              stroke={SLEIGH_COLORS.ink}
              strokeWidth={0.45}
              strokeLinecap="round"
            />
          </G>
        ))}
        <Circle
          cx={shapes.nose.cx}
          cy={shapes.nose.cy}
          r={shapes.nose.glowR}
          fill={`url(#${noseId})`}
        />
        <Circle
          cx={shapes.nose.cx}
          cy={shapes.nose.cy}
          r={shapes.nose.r}
          fill={SLEIGH_COLORS.nose}
        />
      </G>
      {SLEIGH_TRAIL_DUST.map((mote) => (
        <Circle
          key={mote.cx}
          cx={mote.cx}
          cy={mote.cy}
          r={mote.r}
          fill={SLEIGH_COLORS.dust}
          fillOpacity={mote.opacity}
        />
      ))}
      {SLEIGH_TRAIL_STARS.map((star) => (
        <Path
          key={star.x}
          d={fourPointStarPath(star.x, star.y, star.size)}
          fill={SLEIGH_COLORS.dust}
          fillOpacity={star.opacity}
        />
      ))}
    </>
  );
}
