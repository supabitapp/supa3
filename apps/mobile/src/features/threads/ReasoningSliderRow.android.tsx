import { Host, Slider } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  ReasoningSliderRowContent,
  type ReasoningSliderRowProps,
  type ReasoningSliderControl,
} from "./ReasoningSliderRow.shared";

function NativeReasoningSlider(control: ReasoningSliderControl) {
  const {
    themeAppearance,
    systemColorsActive,
    themeVariables: colors,
  } = useAppearancePreferences();
  return (
    <Host
      colorScheme={themeAppearance}
      seedColor={systemColorsActive ? undefined : colors["--color-primary"]}
      style={{ height: 48, width: "100%" }}
    >
      <Slider
        min={0}
        max={control.max}
        steps={Math.max(0, control.max - 1)}
        value={control.value}
        enabled={!control.disabled}
        modifiers={[fillMaxWidth()]}
        colors={{
          thumbColor: colors["--color-primary"],
          activeTrackColor: colors["--color-primary"],
          inactiveTrackColor: colors["--color-secondary"],
        }}
        onValueChange={control.onValueChange}
        onValueChangeFinished={control.onValueChangeFinished}
      />
    </Host>
  );
}

export function ReasoningSliderRow(props: ReasoningSliderRowProps) {
  return <ReasoningSliderRowContent {...props} SliderComponent={NativeReasoningSlider} />;
}
