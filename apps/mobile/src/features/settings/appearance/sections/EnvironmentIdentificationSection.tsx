import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentIdentificationModes } from "@supacode/client-runtime/stage-artwork";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  type EnvironmentIdentificationMode,
} from "@supacode/contracts";
import { AsyncResult } from "effect/reactivity";

import { MOBILE_STAGE_LABEL } from "../../../../components/useEnvironmentIdentification";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsChoiceRow } from "../../components/SettingsChoiceRow";
import { SettingsSection } from "../../components/SettingsSection";

const MODES = resolveEnvironmentIdentificationModes(MOBILE_STAGE_LABEL);

const MODE_PRESENTATION: Record<
  EnvironmentIdentificationMode,
  { readonly label: string; readonly description: string }
> = {
  artwork: {
    label: "Artwork",
    description: MOBILE_STAGE_LABEL
      ? "Stage artwork behind the thread list header."
      : "Artwork behind the thread list header under dark themes.",
  },
  pill: {
    label: "Version pill",
    description: `A ${MOBILE_STAGE_LABEL ?? "stage"} label beside the Supacode title.`,
  },
  none: {
    label: "None",
    description: "A plain header.",
  },
};

/** Mirrors the web "Environment identification" setting for this device. */
export function EnvironmentIdentificationSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  if (MODES.length < 2) return null;

  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedMode = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.environmentIdentificationMode ??
      DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)
    : null;

  return (
    <SettingsSection title="Environment identification">
      {MODES.map((mode, index) => (
        <SettingsChoiceRow
          key={mode}
          label={MODE_PRESENTATION[mode].label}
          description={MODE_PRESENTATION[mode].description}
          selected={selectedMode === mode}
          separated={index > 0}
          disabled={!preferencesReady}
          onPress={() => savePreferences({ environmentIdentificationMode: mode })}
        />
      ))}
    </SettingsSection>
  );
}
