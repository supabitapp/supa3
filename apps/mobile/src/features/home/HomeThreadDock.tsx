import { useEffect, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";

import { AppText } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import type { HomeThreadSection } from "./home-thread-sections";

const SECTION_LABELS = { working: "Working", snoozed: "Snoozed", settled: "Settled" };
const DRAWER_SPRING = { dampingRatio: 1, reduceMotion: ReduceMotion.System } as const;
// Reanimated's spring duration is perceptual; the full animation lasts 1.5 times as long.
const DRAWER_ENTER_DURATION = 180;
const DRAWER_EXIT_DURATION = 130;

function createDrawerDrag({
  progress,
  dragStart,
  releaseVelocity,
  height,
  onClose,
}: {
  progress: SharedValue<number>;
  dragStart: SharedValue<number>;
  releaseVelocity: SharedValue<number>;
  height: number;
  onClose: () => void;
}) {
  return Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-12, 12])
    .onStart(() => {
      cancelAnimation(progress);
      dragStart.set(progress.get());
    })
    .onUpdate((event) => {
      progress.set(Math.min(1, Math.max(0, dragStart.get() + event.translationY / height)));
    })
    .onEnd((event, success) => {
      if (success && (progress.get() > 0.22 || event.velocityY > 600)) {
        releaseVelocity.set(event.velocityY / height);
        runOnJS(onClose)();
      } else {
        progress.set(
          withSpring(0, {
            ...DRAWER_SPRING,
            duration: DRAWER_ENTER_DURATION,
            velocity: event.velocityY / height,
          }),
        );
      }
    });
}

export function HomeThreadDock(props: {
  readonly counts: Record<HomeThreadSection, number>;
  readonly selectedSection: HomeThreadSection | null;
  readonly onToggle: (section: HomeThreadSection) => void;
}) {
  const sections: HomeThreadSection[] = ["working"];
  if (props.counts.snoozed > 0 || props.selectedSection === "snoozed") sections.push("snoozed");
  sections.push("settled");

  return (
    <View className="flex-row gap-1 border-t border-border-subtle bg-screen px-4 py-1.5">
      {sections.map((section) => {
        const selected = props.selectedSection === section;
        return (
          <Pressable
            key={section}
            accessibilityRole="button"
            accessibilityLabel={`${SECTION_LABELS[section]}, ${props.counts[section]} ${props.counts[section] === 1 ? "thread" : "threads"}`}
            accessibilityState={{ expanded: selected, selected }}
            onPress={() => props.onToggle(section)}
            className={cn(
              "min-h-11 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl px-2",
              selected && "bg-subtle",
            )}
          >
            <AppText className={cn("text-sm", !selected && "text-foreground-muted")}>
              {SECTION_LABELS[section]}
            </AppText>
            <AppText className="text-xs tabular-nums text-foreground-muted">
              {props.counts[section]}
            </AppText>
            <SymbolView
              name={selected ? "chevron.down" : "chevron.up"}
              size={10}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** One interruptible drawer above the dock; category changes replace its contents in place. */
export function HomeThreadDrawer(props: {
  readonly section: HomeThreadSection;
  readonly count: number;
  readonly open: boolean;
  readonly height: number;
  readonly onClose: () => void;
  readonly onClosed: () => void;
  readonly children: ReactNode;
}) {
  const { open, height, onClose, onClosed } = props;
  const progress = useSharedValue(1);
  const dragStart = useSharedValue(0);
  const releaseVelocity = useSharedValue(0);

  useEffect(() => {
    progress.set(
      withSpring(
        open ? 0 : 1,
        {
          ...DRAWER_SPRING,
          duration: open ? DRAWER_ENTER_DURATION : DRAWER_EXIT_DURATION,
          velocity: releaseVelocity.get(),
        },
        (finished) => {
          if (finished && !open) runOnJS(onClosed)();
        },
      ),
    );
    releaseVelocity.set(0);
  }, [onClosed, open, progress, releaseVelocity]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.get() * height }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - progress.get()) * 0.16,
  }));
  const drag = createDrawerDrag({ progress, dragStart, releaseVelocity, height, onClose });

  return (
    <View
      className="absolute inset-0 overflow-hidden"
      pointerEvents={open ? "box-none" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      onAccessibilityEscape={onClose}
    >
      <Animated.View className="absolute inset-0 bg-black" style={backdropStyle}>
        <Pressable
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel="Close thread drawer"
          onPress={onClose}
        />
      </Animated.View>
      <Animated.View
        className="absolute inset-x-0 bottom-0 overflow-hidden rounded-t-3xl border border-border-subtle bg-screen"
        style={[{ height }, panelStyle]}
      >
        <GestureDetector gesture={drag}>
          <View>
            <View className="items-center pt-2">
              <View className="h-1 w-8 rounded-full bg-subtle-strong" />
            </View>
            <View className="flex-row items-center justify-between px-4 pb-2 pt-1">
              <AppText accessibilityRole="header" className="text-base font-supacode-medium">
                {SECTION_LABELS[props.section]} ({props.count})
              </AppText>
              <Pressable
                className="h-11 w-11 items-center justify-center"
                accessibilityRole="button"
                accessibilityLabel={`Close ${SECTION_LABELS[props.section]}`}
                onPress={onClose}
              >
                <SymbolView name="xmark" size={17} tintColorClassName="accent-icon-muted" />
              </Pressable>
            </View>
          </View>
        </GestureDetector>
        {props.children}
      </Animated.View>
    </View>
  );
}
