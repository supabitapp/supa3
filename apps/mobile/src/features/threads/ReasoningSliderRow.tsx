import { Host, Slider } from "@expo/ui/swift-ui";
import { disabled } from "@expo/ui/swift-ui/modifiers";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  ReasoningSliderRowContent,
  type ReasoningSliderRowProps,
  type ReasoningSliderControl,
} from "./ReasoningSliderRow.shared";

function NativeReasoningSlider(control: ReasoningSliderControl) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  return (
    <Host
      colorScheme={themeAppearance}
      seedColor={colors["--color-primary"]}
      style={{ height: 44, width: "100%" }}
    >
      <Slider
        min={0}
        max={control.max}
        step={1}
        value={control.value}
        modifiers={[disabled(control.disabled)]}
        onValueChange={control.onValueChange}
        onEditingChanged={(isEditing) => {
          if (!isEditing) control.onValueChangeFinished();
        }}
      />
    </Host>
  );
}

export function ReasoningSliderRow(props: ReasoningSliderRowProps) {
  return <ReasoningSliderRowContent {...props} SliderComponent={NativeReasoningSlider} />;
}
