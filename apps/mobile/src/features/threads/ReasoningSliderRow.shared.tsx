import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export type ReasoningSliderRowProps = {
  readonly label: string;
  readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly selectedIndex: number;
  readonly onChange: (value: string) => void;
};

export type ReasoningSliderControl = {
  readonly value: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly onValueChange: (value: number) => void;
  readonly onValueChangeFinished: () => void;
};

/** Previews each stop locally; only a completed adjustment updates the model. */
export function ReasoningSliderRowContent(
  props: ReasoningSliderRowProps & {
    readonly SliderComponent: ComponentType<ReasoningSliderControl>;
  },
) {
  const SliderComponent = props.SliderComponent;
  const [draft, setDraft] = useState({
    selectedIndex: props.selectedIndex,
    previewIndex: props.selectedIndex,
  });
  if (draft.selectedIndex !== props.selectedIndex) {
    setDraft({ selectedIndex: props.selectedIndex, previewIndex: props.selectedIndex });
  }
  const previewIndex =
    draft.selectedIndex === props.selectedIndex ? draft.previewIndex : props.selectedIndex;
  const draftIndex = useRef(props.selectedIndex);
  useEffect(() => {
    draftIndex.current = props.selectedIndex;
  }, [props.selectedIndex]);

  const max = props.choices.length - 1;
  const disabled = max < 1;
  const valueLabel = props.choices[previewIndex]?.label;
  const commit = (index: number) => {
    const choice = props.choices[index];
    if (!disabled && choice && index !== props.selectedIndex) props.onChange(choice.id);
  };
  const onValueChange = (value: number) => {
    if (disabled) return;
    const next = Math.min(max, Math.max(0, Math.round(value)));
    if (next === draftIndex.current) return;
    draftIndex.current = next;
    setDraft({ selectedIndex: props.selectedIndex, previewIndex: next });
    void Haptics.selectionAsync().catch(() => undefined);
  };
  const onValueChangeFinished = () => commit(draftIndex.current);

  return (
    <View className="border-b border-border-subtle bg-grouped-card px-4 pb-1 pt-3">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-sm font-supacode-medium text-foreground">
          {props.label}
        </Text>
        <Text className="text-sm text-foreground-muted">{valueLabel}</Text>
      </View>
      <View
        accessible
        accessibilityLabel={props.label}
        accessibilityRole="adjustable"
        accessibilityState={{ disabled }}
        accessibilityValue={{ min: 0, max, now: previewIndex, text: valueLabel }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (
            disabled ||
            (nativeEvent.actionName !== "increment" && nativeEvent.actionName !== "decrement")
          )
            return;
          const next = Math.min(
            max,
            Math.max(0, props.selectedIndex + (nativeEvent.actionName === "increment" ? 1 : -1)),
          );
          if (next !== props.selectedIndex) {
            void Haptics.selectionAsync().catch(() => undefined);
            commit(next);
          }
        }}
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <SliderComponent
            value={previewIndex}
            max={Math.max(1, max)}
            disabled={disabled}
            onValueChange={onValueChange}
            onValueChangeFinished={onValueChangeFinished}
          />
        </View>
      </View>
    </View>
  );
}
