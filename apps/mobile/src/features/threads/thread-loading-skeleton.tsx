/**
 * Adapted from https://nativemotion.dev/docs/components/skeleton.
 * MIT License
 * Copyright (c) 2025 nativemotion
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { useEffect, useId } from "react";
import { StyleSheet, View, type DimensionValue, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/** Plays one highlight sweep on its first layout, then rests until the conversation arrives. */
export function ThreadLoadingSkeleton(props: {
  readonly width?: DimensionValue;
  readonly height?: number;
  readonly radius?: number;
  readonly shimmerColor: string;
}) {
  const progress = useSharedValue(0);
  const measuredWidth = useSharedValue(0);
  const gradientId = `thread-skeleton-${useId().replaceAll(":", "")}`;
  const sweepStyle = useAnimatedStyle(() => ({
    opacity: measuredWidth.value > 0 ? 1 : 0,
    transform: [{ translateX: measuredWidth.value * (progress.value * 2 - 1) }],
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const firstLayout = measuredWidth.get() === 0;
    measuredWidth.set(event.nativeEvent.layout.width);
    if (firstLayout && event.nativeEvent.layout.width > 0) {
      progress.set(
        withTiming(1, {
          duration: 280,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.System,
        }),
      );
    }
  };
  useEffect(() => () => cancelAnimation(progress), [progress]);

  return (
    <View
      className="overflow-hidden bg-foreground/10"
      onLayout={onLayout}
      style={{
        width: props.width ?? "100%",
        height: props.height ?? 12,
        borderRadius: props.radius ?? 6,
      }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, sweepStyle]}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
              <Stop offset="0" stopColor={props.shimmerColor} stopOpacity={0} />
              <Stop offset="0.5" stopColor={props.shimmerColor} stopOpacity={0.7} />
              <Stop offset="1" stopColor={props.shimmerColor} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}
