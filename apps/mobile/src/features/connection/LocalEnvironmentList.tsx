import type { EnvironmentId } from "@supacode/contracts";
import type { ComponentProps } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ConnectionEnvironmentRow } from "./ConnectionEnvironmentRow";

type EnvironmentRowProps = ComponentProps<typeof ConnectionEnvironmentRow>;

/** Shared list and empty state for environment management entry points. */
export function LocalEnvironmentList({
  environments,
  expandedId,
  onToggle,
  ...rowActions
}: Pick<
  EnvironmentRowProps,
  "onReconnect" | "onRemove" | "onSetEnabled" | "onUpdate" | "opensDetails"
> & {
  readonly environments: ReadonlyArray<EnvironmentRowProps["environment"]>;
  readonly expandedId: EnvironmentId | null;
  readonly onToggle: (environmentId: EnvironmentId) => void;
}) {
  if (environments.length === 0) {
    return (
      <View
        collapsable={false}
        className="items-center gap-3 rounded-[24px] bg-grouped-card px-6 py-8"
      >
        <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
          <SymbolView
            name="point.3.connected.trianglepath.dotted"
            size={20}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </View>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          No environments connected yet.{"\n"}Tap{" "}
          <Text className="font-supacode-bold text-foreground">+</Text> to add one.
        </Text>
      </View>
    );
  }

  return (
    <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
      {environments.map((environment) => (
        <Animated.View
          key={environment.environmentId}
          collapsable={false}
          entering={FadeIn.duration(140)}
          exiting={FadeOut.duration(120)}
          layout={LinearTransition.duration(220)}
        >
          <ConnectionEnvironmentRow
            environment={environment}
            expanded={expandedId === environment.environmentId}
            onToggle={() => onToggle(environment.environmentId)}
            {...rowActions}
          />
        </Animated.View>
      ))}
    </View>
  );
}
