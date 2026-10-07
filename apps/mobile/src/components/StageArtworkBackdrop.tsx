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
  type StageArtworkAppearance,
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
import Constants from "expo-constants";
import { type ComponentType, useId, useState } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
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
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";

// The web's default stage palette, resolved to sRGB for react-native-svg.
const NIGHT = {
  top: "#32155B",
  mid: "#151443",
  bottom: "#07152F",
  secondary: "#696FEA",
  line: "#E4EAFF",
  sparkle: "#C8D7FF",
  meteorTail: "#C4B6F6",
} as const;

const WIREFRAME = {
  light: { top: "#67C2FF", mid: "#347FF8", bottom: "#1538D0" },
  dark: { top: "#3A7AD1", mid: "#2050AE", bottom: "#101F6E" },
  highlight: "#D4F6FF",
  line: "#DDF7FF",
} as const;

const SLEIGH = {
  halo: "#E8D7A3",
  moonHighlight: "#FFFCED",
  moon: "#E5D6B6",
  crater: "#CBBBA1",
  ink: "#060E25",
  nose: "#FF2C29",
  dust: "#FFE196",
} as const;

// Matches the web header fade, as positions within the fade span.
const FADE_STOPS = [
  [0, 0],
  [0.18, 0.1],
  [0.37, 0.3],
  [0.55, 0.58],
  [0.72, 0.82],
  [0.88, 0.96],
  [1, 1],
] as const;

// react-native-svg has no spreadMethod, so reflected gradients stretch the vector and
// alternate the stops instead; this many repeats covers the widest phone or sidebar header.
const REFLECT_REPEATS = 8;

/**
 * Stage art shown behind mobile headers. Native chrome only lets it through where the
 * header is transparent: Liquid Glass on iOS and the custom Material toolbar on Android.
 */
export function useStageArtworkVariant(): StageArtworkVariant | null {
  const { themeAppearance } = useAppearancePreferences();
  if (Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED) return null;
  return resolveVisibleStageArtworkVariant(
    resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant),
    themeAppearance,
  );
}

/**
 * Fills its parent with the stage art and fades it into the `fadeTo` theme color from
 * `fadeStart`, a fraction of its height, to the bottom edge.
 */
export function StageArtworkBackdrop(props: {
  readonly variant: StageArtworkVariant;
  readonly fadeTo: "--color-screen" | "--color-header" | "--color-drawer";
  readonly fadeStart: number;
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
  const units = size && size.height > 0 ? (size.width * STAGE_ARTWORK_HEIGHT) / size.height : 0;
  const Art = STAGE_ARTWORK[props.variant];

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {size && units > 0 ? (
        <Svg
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${units} ${STAGE_ARTWORK_HEIGHT}`}
        >
          <Art units={units} appearance={themeAppearance} />
          <Defs>
            <LinearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
              {FADE_STOPS.map(([position, opacity]) => (
                <Stop
                  key={position}
                  offset={props.fadeStart + (1 - props.fadeStart) * position}
                  stopColor={fadeColor}
                  stopOpacity={opacity}
                />
              ))}
            </LinearGradient>
          </Defs>
          <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${fadeId})`} />
        </Svg>
      ) : null}
    </View>
  );
}

interface ArtProps {
  readonly units: number;
  readonly appearance: StageArtworkAppearance;
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
  readonly vector: { x1: number; y1: number; x2: number; y2: number };
  readonly colors: readonly [string, string, string];
}) {
  const { x1, y1, x2, y2 } = props.vector;
  const [start, middle, end] = props.colors;
  const stops: Array<[number, string]> = [];
  for (let leg = 0; leg < REFLECT_REPEATS; leg++) {
    const forward = leg % 2 === 0;
    stops.push([leg / REFLECT_REPEATS, forward ? start : end]);
    stops.push([(leg + 0.5) / REFLECT_REPEATS, middle]);
  }
  stops.push([1, REFLECT_REPEATS % 2 === 0 ? start : end]);
  return (
    <LinearGradient
      id={props.id}
      x1={x1}
      y1={y1}
      x2={x1 + (x2 - x1) * REFLECT_REPEATS}
      y2={y1 + (y2 - y1) * REFLECT_REPEATS}
      gradientUnits="userSpaceOnUse"
    >
      {stops.map(([offset, color]) => (
        <Stop key={offset} offset={offset} stopColor={color} />
      ))}
    </LinearGradient>
  );
}

function NightStars(props: {
  readonly units: number;
  readonly tileWidth: number;
  readonly stars: ReadonlyArray<StageStar>;
  readonly sparkles: ReadonlyArray<StageSparkle>;
}) {
  return tileOffsets(props.units, props.tileWidth).map((offset) => (
    <G key={offset} x={offset}>
      {props.stars.map((star) => (
        <Circle
          key={`${star.cx}-${star.cy}`}
          cx={star.cx}
          cy={star.cy}
          r={star.r}
          fill={NIGHT.line}
          fillOpacity={star.opacity}
        />
      ))}
      {props.sparkles.map((sparkle) => (
        <Path
          key={`${sparkle.x}-${sparkle.y}`}
          d={sparklePath(sparkle)}
          fill="none"
          stroke={NIGHT.sparkle}
          strokeLinecap="round"
          strokeOpacity={0.7}
          strokeWidth={0.6}
        />
      ))}
    </G>
  ));
}

function MeteorShowerArt({ units }: ArtProps) {
  const prefix = useSvgId();
  const skyId = `${prefix}-sky`;
  const tailId = (index: number) => `${prefix}-tail-${index}`;

  return (
    <>
      <Defs>
        <ReflectedGradient
          id={skyId}
          vector={NIGHT_SKY_GRADIENT}
          colors={[NIGHT.bottom, NIGHT.mid, NIGHT.top]}
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
            <Stop offset={0} stopColor={NIGHT.line} />
            <Stop offset={0.25} stopColor={NIGHT.meteorTail} stopOpacity={0.85} />
            <Stop offset={1} stopColor={NIGHT.meteorTail} stopOpacity={0} />
          </LinearGradient>
        ))}
      </Defs>
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${skyId})`} />
      <NightStars
        units={units}
        tileWidth={METEOR_SHOWER_STAR_TILE_WIDTH}
        stars={METEOR_SHOWER_STARS}
        sparkles={METEOR_SHOWER_SPARKLES}
      />
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
              <Circle cx={meteor.x1} cy={meteor.y1} r={1.05} fill={NIGHT.line} />
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
  const paper = WIREFRAME[appearance];

  return (
    <>
      <Defs>
        <ReflectedGradient
          id={paperId}
          vector={WIREFRAME_PAPER_GRADIENT}
          colors={[paper.bottom, paper.mid, paper.top]}
        />
        <RadialGradient
          id={glowId}
          cx={0}
          cy={0}
          r={1}
          gradientTransform={WIREFRAME_GLOW_TRANSFORM}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset={0} stopColor={WIREFRAME.highlight} stopOpacity={0.4} />
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
            fill={WIREFRAME.line}
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
            stroke={WIREFRAME.line}
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
            stroke={WIREFRAME.line}
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
          colors={[NIGHT.bottom, NIGHT.mid, NIGHT.top]}
        />
        <RadialGradient
          id={haloId}
          cx={0}
          cy={0}
          r={1}
          gradientTransform={SLEIGH_HALO_TRANSFORM}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset={0} stopColor={SLEIGH.halo} stopOpacity={0.34} />
          <Stop offset={0.38} stopColor={NIGHT.secondary} stopOpacity={0.12} />
          <Stop offset={1} stopColor={NIGHT.top} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={moonId} cx="0.42" cy="0.38" r="0.7">
          <Stop offset={0} stopColor={SLEIGH.moonHighlight} />
          <Stop offset={1} stopColor={SLEIGH.moon} />
        </RadialGradient>
        <RadialGradient id={noseId}>
          <Stop offset={0} stopColor={SLEIGH.nose} stopOpacity={0.75} />
          <Stop offset={1} stopColor={SLEIGH.nose} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={units} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${skyId})`} />
      <NightStars
        units={units}
        tileWidth={SLEIGH_STAR_TILE_WIDTH}
        stars={SLEIGH_STARS}
        sparkles={SLEIGH_SPARKLES}
      />
      <Rect width={SLEIGH_HALO_WIDTH} height={STAGE_ARTWORK_HEIGHT} fill={`url(#${haloId})`} />
      <Circle {...SLEIGH_MOON} fill={`url(#${moonId})`} />
      {SLEIGH_MOON_CRATERS.map((crater) => (
        <Circle
          key={`${crater.cx}-${crater.cy}`}
          {...crater}
          fill={SLEIGH.crater}
          fillOpacity={0.32}
        />
      ))}
      <G transform={SLEIGH_TRANSFORM}>
        <Path d={shapes.sleighPath} fill={SLEIGH.ink} />
        <Circle {...shapes.sackCircle} fill={SLEIGH.ink} />
        <Path d={shapes.riderPath} fill={SLEIGH.ink} />
        <Circle {...shapes.riderHeadCircle} fill={SLEIGH.ink} />
        <Path
          d={shapes.runnersPath}
          fill="none"
          stroke={SLEIGH.ink}
          strokeWidth={0.6}
          strokeLinecap="round"
        />
        <Path
          d={shapes.reinsPath}
          fill="none"
          stroke={SLEIGH.ink}
          strokeWidth={0.35}
          strokeLinecap="round"
        />
        {SLEIGH_REINDEER.map((reindeer) => (
          <G key={reindeer.x} x={reindeer.x} y={reindeer.y}>
            <Path d={shapes.reindeerBodyPath} fill={SLEIGH.ink} />
            <Path
              d={shapes.reindeerLegsPath}
              fill="none"
              stroke={SLEIGH.ink}
              strokeWidth={0.65}
              strokeLinecap="round"
            />
            <Path
              d={shapes.reindeerAntlersPath}
              fill="none"
              stroke={SLEIGH.ink}
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
        <Circle cx={shapes.nose.cx} cy={shapes.nose.cy} r={shapes.nose.r} fill={SLEIGH.nose} />
      </G>
      {SLEIGH_TRAIL_DUST.map((mote) => (
        <Circle
          key={mote.cx}
          cx={mote.cx}
          cy={mote.cy}
          r={mote.r}
          fill={SLEIGH.dust}
          fillOpacity={mote.opacity}
        />
      ))}
      {SLEIGH_TRAIL_STARS.map((star) => (
        <Path
          key={star.x}
          d={fourPointStarPath(star.x, star.y, star.size)}
          fill={SLEIGH.dust}
          fillOpacity={star.opacity}
        />
      ))}
    </>
  );
}
