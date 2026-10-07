import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentIdentificationPillLabel,
  resolveEnvironmentIdentificationPillLabel,
  resolveVisibleStageArtworkVariant,
  type StageArtworkVariant,
} from "@supacode/client-runtime/stage-artwork";
import { DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE } from "@supacode/contracts";
import { AsyncResult } from "effect/reactivity";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";
import { mobilePreferencesAtom } from "../state/preferences";

// Stage art only shows through transparent headers: Liquid Glass on iOS and the custom
// Material toolbar on Android.
const ARTWORK_SUPPORTED = Platform.OS !== "ios" || NATIVE_LIQUID_GLASS_SUPPORTED;

export const MOBILE_STAGE_LABEL = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);

/**
 * How the brand header identifies a Dev or Nightly build: stage artwork behind it, a pill beside
 * the title, or nothing. Follows the device's `environmentIdentificationMode` preference.
 */
export function useEnvironmentIdentification(): {
  readonly artworkVariant: StageArtworkVariant | null;
  readonly pillLabel: EnvironmentIdentificationPillLabel | null;
} {
  const { themeAppearance } = useAppearancePreferences();
  const preferences = useAtomValue(mobilePreferencesAtom);
  // Avoid briefly rendering the default artwork before a persisted pill or none choice loads.
  if (!AsyncResult.isSuccess(preferences)) return { artworkVariant: null, pillLabel: null };

  const mode =
    preferences.value.environmentIdentificationMode ?? DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE;
  const artworkVariant =
    mode === "artwork" && ARTWORK_SUPPORTED
      ? resolveVisibleStageArtworkVariant(MOBILE_STAGE_LABEL, themeAppearance)
      : null;
  // Where artwork cannot show, the artwork choice still identifies the build with the pill.
  const showPill = mode === "pill" || (mode === "artwork" && !ARTWORK_SUPPORTED);
  return {
    artworkVariant,
    pillLabel: showPill ? resolveEnvironmentIdentificationPillLabel(MOBILE_STAGE_LABEL) : null,
  };
}
