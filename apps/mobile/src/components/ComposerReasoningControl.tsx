import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@supacode/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@supacode/shared/model";
import * as Haptics from "expo-haptics";

import { selectableChoices } from "../features/threads/thread-settings-options";
import { applyProviderOptionSelection, getReasoningOptionDescriptor } from "../lib/providerOptions";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ControlPillMenu } from "./ControlPill";

export function ComposerReasoningControl(props: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly selectedModel: ModelSelection | null;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly disabled?: boolean;
  readonly onChange: (options: ReadonlyArray<ProviderOptionSelection>) => void;
}) {
  const descriptor = getReasoningOptionDescriptor(props.descriptors);
  if (!descriptor) {
    return null;
  }

  const choices =
    descriptor.type === "select"
      ? selectableChoices(descriptor).map((choice) => ({
          id: choice.id,
          label: choice.label,
          value: choice.id,
        }))
      : [
          { id: "on", label: "On", value: true },
          { id: "off", label: "Off", value: false },
        ];
  if (choices.length === 0) {
    return null;
  }

  const currentValue = getProviderOptionCurrentValue(
    descriptor,
    props.selectedModel,
    props.reportedModelSelection,
  );
  const label =
    choices.find((choice) => choice.value === currentValue)?.label ??
    getProviderOptionCurrentLabel(descriptor, props.selectedModel, props.reportedModelSelection) ??
    "Default";
  const accessibilityLabel = `${descriptor.label}: ${label}`;
  const control = (
    <ComposerInlineControl
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Choose the reasoning level for this model"
      disabled={props.disabled}
      label={label}
      maxWidth={110}
    />
  );

  if (props.disabled) {
    return control;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      title={descriptor.label}
      style={{ flexShrink: 0 }}
      actions={choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        state: choice.value === currentValue ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => {
        const choice = choices.find((candidate) => candidate.id === nativeEvent.event);
        if (!choice) {
          return;
        }
        const options = applyProviderOptionSelection(props.descriptors, {
          id: descriptor.id,
          value: choice.value,
        });
        if (options) {
          void Haptics.selectionAsync();
          props.onChange(options);
        }
      }}
    >
      {control}
    </ControlPillMenu>
  );
}
