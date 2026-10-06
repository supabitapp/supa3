import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { isKeyboardMotionSuppressed } from "../lib/motionInput";
import { useReducedMotionPreference } from "../lib/useReducedMotionPreference";

/** Cross-fades discrete states, keeping retiring content inert and same-state updates immediate. */
export function MotionSwap({
  stateKey,
  children,
  fill = false,
  ...props
}: Omit<ComponentProps<typeof View>, "children"> & {
  readonly stateKey: string;
  readonly children: ReactNode | ((active: boolean) => ReactNode);
  readonly fill?: boolean;
}) {
  const reducedMotion = useReducedMotionPreference();
  const immediate = reducedMotion || isKeyboardMotionSuppressed();
  const [layers, setLayers] = useState([{ key: stateKey, children }]);
  const [previous, setPrevious] = useState({ key: stateKey, children });
  const currentKey = useRef(stateKey);
  useLayoutEffect(() => {
    currentKey.current = stateKey;
  }, [stateKey]);
  if (previous.key !== stateKey || previous.children !== children) {
    setPrevious({ key: stateKey, children });
  }
  if (layers.at(-1)?.key !== stateKey) {
    setLayers(
      immediate
        ? [{ key: stateKey, children }]
        : [
            ...layers
              .filter((layer) => layer.key !== stateKey)
              .map((layer) => (layer.key === previous.key ? previous : layer)),
            { key: stateKey, children },
          ],
    );
  }
  const remove = useCallback((key: string) => {
    if (currentKey.current === key) return;
    setLayers((current) => current.filter((layer) => layer.key !== key));
  }, []);
  return (
    <View {...props}>
      {layers.map((layer) => {
        const active = layer.key === stateKey;
        const content = active ? children : layer.children;
        return (
          <SwapLayer
            key={layer.key}
            layerKey={layer.key}
            active={layer.key === stateKey}
            appear={layers.length > 1}
            immediate={immediate}
            fill={fill}
            onHidden={remove}
          >
            {typeof content === "function" ? content(active) : content}
          </SwapLayer>
        );
      })}
    </View>
  );
}

function SwapLayer(props: {
  readonly layerKey: string;
  readonly active: boolean;
  readonly appear: boolean;
  readonly immediate: boolean;
  readonly fill: boolean;
  readonly onHidden: (key: string) => void;
  readonly children: ReactNode;
}) {
  const { active, immediate, layerKey, onHidden } = props;
  const opacity = useSharedValue(active && (!props.appear || immediate) ? 1 : 0);
  useLayoutEffect(() => {
    if (immediate) {
      opacity.set(active ? 1 : 0);
      if (!active) onHidden(layerKey);
      return;
    }
    opacity.set(
      withTiming(
        active ? 1 : 0,
        {
          duration: active ? 160 : 120,
          easing: Easing.bezier(0.32, 0.72, 0, 1),
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          if (finished && !active) runOnJS(onHidden)(layerKey);
        },
      ),
    );
  }, [active, immediate, layerKey, onHidden, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      collapsable={false}
      pointerEvents={active ? "box-none" : "none"}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      style={[
        active
          ? props.fill
            ? { flex: 1 }
            : undefined
          : { position: "absolute", top: 0, left: 0, right: 0, bottom: props.fill ? 0 : undefined },
        style,
      ]}
    >
      {props.children}
    </Animated.View>
  );
}
