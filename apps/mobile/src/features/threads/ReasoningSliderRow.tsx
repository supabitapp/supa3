import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const THUMB_SIZE = 28;
const TRACK_HEIGHT = 24;
const TOUCH_HEIGHT = 44;
const DOT_SIZE = 4;
const SNAP_ANIMATION = { duration: 120 } as const;

export type ReasoningSliderRowProps = {
  readonly label: string;
  readonly choices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly isDefault?: boolean;
  }>;
  readonly selectedIndex: number;
  readonly onChange: (value: string) => void;
};

function createReasoningGesture(input: {
  readonly disabled: boolean;
  readonly max: number;
  readonly selectedIndex: number;
  readonly progress: SharedValue<number>;
  readonly trackWidth: SharedValue<number>;
  readonly dragging: SharedValue<boolean>;
  readonly lastStop: SharedValue<number>;
  readonly preview: (index: number, haptic?: boolean) => void;
  readonly commit: (index: number) => void;
}) {
  const {
    disabled,
    max,
    selectedIndex,
    progress,
    trackWidth,
    dragging,
    lastStop,
    preview,
    commit,
  } = input;
  const fractionAt = (x: number) => {
    "worklet";
    const usable = trackWidth.value - THUMB_SIZE;
    return usable > 0 ? Math.min(1, Math.max(0, (x - THUMB_SIZE / 2) / usable)) : 0;
  };
  const update = (fraction: number) => {
    "worklet";
    progress.set(fraction);
    const next = Math.round(fraction * max);
    if (next !== lastStop.value) {
      lastStop.set(next);
      runOnJS(preview)(next);
    }
  };
  const pan = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-6, 6])
    .failOffsetY([-12, 12])
    .onStart(() => {
      dragging.set(true);
    })
    .onUpdate((event) => update(fractionAt(event.x)))
    .onFinalize((_event, success) => {
      if (!dragging.value) return;
      dragging.set(false);
      if (!success) {
        progress.set(withTiming(selectedIndex / max, SNAP_ANIMATION));
        lastStop.set(selectedIndex);
        runOnJS(preview)(selectedIndex, false);
        return;
      }
      const next = lastStop.value;
      progress.set(withTiming(next / max, SNAP_ANIMATION));
      runOnJS(commit)(next);
    });
  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd((event, success) => {
      if (!success) return;
      const next = Math.round(fractionAt(event.x) * max);
      update(next / max);
      runOnJS(commit)(next);
    });
  return Gesture.Race(pan, tap);
}

/** Moves the thumb on the UI thread; previews stops in JS and saves only on release. */
export function ReasoningSliderRow(props: ReasoningSliderRowProps) {
  const { selectedIndex, choices, onChange } = props;
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const accent = themeAppearance === "dark" ? "#70A4A7" : "#38787D";
  const max = choices.length - 1;
  const disabled = max < 1;
  const defaultIndex = choices.findIndex((choice) => choice.isDefault);
  const progress = useSharedValue(max > 0 ? selectedIndex / max : 0);
  const trackWidth = useSharedValue(0);
  const dragging = useSharedValue(false);
  const lastStop = useSharedValue(selectedIndex);
  const [draft, setDraft] = useState({ selectedIndex, previewIndex: selectedIndex });
  if (draft.selectedIndex !== selectedIndex) {
    setDraft({ selectedIndex, previewIndex: selectedIndex });
  }
  const previewIndex = draft.selectedIndex === selectedIndex ? draft.previewIndex : selectedIndex;

  useEffect(() => {
    if (!dragging.get()) {
      progress.set(withTiming(max > 0 ? selectedIndex / max : 0, SNAP_ANIMATION));
      lastStop.set(selectedIndex);
    }
  }, [dragging, lastStop, max, progress, selectedIndex]);

  const preview = useCallback(
    (index: number, haptic = true) => {
      setDraft({ selectedIndex, previewIndex: index });
      if (haptic) void Haptics.selectionAsync().catch(() => undefined);
    },
    [selectedIndex],
  );
  const commit = useCallback(
    (index: number) => {
      const choice = choices[index];
      if (!disabled && choice && index !== selectedIndex) onChange(choice.id);
    },
    [choices, disabled, onChange, selectedIndex],
  );
  const select = (index: number) => {
    if (disabled) return;
    progress.set(withTiming(index / max, SNAP_ANIMATION));
    lastStop.set(index);
    preview(index, index !== previewIndex);
    commit(index);
  };

  const gesture = useMemo(
    () =>
      createReasoningGesture({
        disabled,
        max,
        selectedIndex,
        progress,
        trackWidth,
        dragging,
        lastStop,
        preview,
        commit,
      }),
    [commit, disabled, dragging, lastStop, max, preview, progress, selectedIndex, trackWidth],
  );

  const fillStyle = useAnimatedStyle(() => ({
    width: THUMB_SIZE / 2 + progress.value * Math.max(0, trackWidth.value - THUMB_SIZE),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * Math.max(0, trackWidth.value - THUMB_SIZE) }],
  }));
  const canReset = !disabled && defaultIndex >= 0 && previewIndex !== defaultIndex;

  return (
    <View className="border-b border-border-subtle bg-grouped-card px-4 pb-2 pt-1">
      <View className="flex-row items-center">
        <View
          className="h-8 w-11 justify-center"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <SymbolView name={{ ios: "bolt.fill", android: "bolt" }} size={18} tintColor={accent} />
        </View>
        <Text
          className="min-w-0 flex-1 text-center text-sm font-supacode-medium"
          style={{ color: accent }}
        >
          {choices[previewIndex]?.label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Reset ${props.label.toLowerCase()} to default`}
          accessibilityState={{ disabled: !canReset }}
          disabled={!canReset}
          className="h-8 w-11 items-end justify-center"
          hitSlop={{ top: 6, bottom: 6 }}
          style={{ opacity: canReset ? 1 : 0.35 }}
          onPress={() => select(defaultIndex)}
        >
          <SymbolView
            name="arrow.clockwise"
            size={18}
            tintColor={colors["--color-foreground-muted"]}
          />
        </Pressable>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityLabel={props.label}
          accessibilityRole="adjustable"
          accessibilityState={{ disabled }}
          accessibilityValue={{
            min: 0,
            max,
            now: previewIndex,
            text: choices[previewIndex]?.label,
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "increment") select(Math.min(max, selectedIndex + 1));
            else if (nativeEvent.actionName === "decrement") select(Math.max(0, selectedIndex - 1));
          }}
          onLayout={(event) => trackWidth.set(event.nativeEvent.layout.width)}
          style={{ height: TOUCH_HEIGHT, opacity: disabled ? 0.5 : 1 }}
        >
          <View
            pointerEvents="none"
            className="absolute inset-x-0 overflow-hidden rounded-full"
            style={{
              top: (TOUCH_HEIGHT - TRACK_HEIGHT) / 2,
              height: TRACK_HEIGHT,
              backgroundColor: themeColorWithAlpha(colors["--color-foreground"], 0.12),
            }}
          >
            <Animated.View
              className="h-full rounded-full"
              style={[{ backgroundColor: accent }, fillStyle]}
            />
          </View>
          <View
            pointerEvents="none"
            className="absolute flex-row justify-between"
            style={{
              left: (THUMB_SIZE - DOT_SIZE) / 2,
              right: (THUMB_SIZE - DOT_SIZE) / 2,
              top: (TOUCH_HEIGHT - DOT_SIZE) / 2,
            }}
          >
            {choices.map((choice, index) => (
              <View
                key={choice.id}
                className="rounded-full"
                style={{
                  width: DOT_SIZE,
                  height: DOT_SIZE,
                  backgroundColor:
                    index <= previewIndex ? "#FFFFFF99" : colors["--color-foreground-muted"],
                }}
              />
            ))}
          </View>
          <Animated.View
            pointerEvents="none"
            className="absolute left-0 rounded-full"
            style={[
              {
                top: (TOUCH_HEIGHT - THUMB_SIZE) / 2,
                width: THUMB_SIZE,
                height: THUMB_SIZE,
                backgroundColor: "#FFFFFF",
                shadowColor: "#000000",
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.15,
                shadowRadius: 2,
                elevation: 2,
              },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
