import { Host, Switch as ComposeSwitch } from "@expo/ui/jetpack-compose";
import * as Haptics from "expo-haptics";
import { View } from "react-native";
import type { ThemedSwitchProps } from "./MaterialSwitch.types";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Material's native switch, with the same palette and accessibility contract as our RN controls. */
export function MaterialSwitch(props: ThemedSwitchProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const change = (value: boolean) => {
    void Haptics.performAndroidHapticsAsync(
      value ? Haptics.AndroidHaptics.Toggle_On : Haptics.AndroidHaptics.Toggle_Off,
    );
    props.onValueChange?.(value);
  };
  const toggle = () => {
    if (!props.disabled) change(!props.value);
  };

  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="switch"
      accessibilityState={{ checked: Boolean(props.value), disabled: Boolean(props.disabled) }}
      accessibilityActions={[{ name: "activate", label: "Toggle" }]}
      onAccessibilityAction={toggle}
      style={props.style}
      testID={props.testID}
    >
      <View importantForAccessibility="no-hide-descendants">
        <Host
          colorScheme={themeAppearance}
          ignoreSafeAreaKeyboardInsets
          style={{ width: 52, height: 48 }}
        >
          <ComposeSwitch
            value={Boolean(props.value)}
            enabled={!props.disabled}
            onCheckedChange={props.onValueChange ? change : undefined}
            colors={{
              checkedTrackColor: colors["--color-switch-active-track"],
              checkedThumbColor: colors["--color-switch-active-thumb"],
              checkedBorderColor: colors["--color-switch-active-track"],
              uncheckedTrackColor: colors["--color-switch-inactive-track"],
              uncheckedThumbColor: colors["--color-switch-inactive-thumb"],
              uncheckedBorderColor: colors["--color-switch-inactive-thumb"],
            }}
          />
        </Host>
      </View>
    </View>
  );
}
