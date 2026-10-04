import { View } from "react-native";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadLoadingSkeleton } from "./thread-loading-skeleton";

/** Conversation-shaped NativeMotion skeletons bridge the history request and list positioning. */
export function ThreadFeedLoading(props: {
  readonly topInset: number;
  readonly bottomInset: number;
  readonly horizontalPadding: number;
}) {
  const { themeAppearance, themeVariables: theme } = useAppearancePreferences();
  const shimmerColor =
    themeAppearance === "dark" ? theme["--color-foreground"] : theme["--color-screen"];
  return (
    <View
      accessible
      accessibilityLabel="Loading conversation"
      accessibilityState={{ busy: true }}
      pointerEvents="none"
      style={{
        flex: 1,
        justifyContent: "flex-end",
        paddingTop: props.topInset + 24,
        paddingBottom: props.bottomInset + 24,
        paddingHorizontal: props.horizontalPadding,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-7"
      >
        <View className="gap-3 px-2">
          <ThreadLoadingSkeleton width="42%" height={10} shimmerColor={shimmerColor} />
          <ThreadLoadingSkeleton width="86%" shimmerColor={shimmerColor} />
          <ThreadLoadingSkeleton width="58%" shimmerColor={shimmerColor} />
        </View>
        <View
          className="self-end gap-3 rounded-2xl bg-user-bubble px-4 py-4"
          style={{ width: "70%" }}
        >
          <ThreadLoadingSkeleton shimmerColor={shimmerColor} />
          <ThreadLoadingSkeleton width="68%" shimmerColor={shimmerColor} />
        </View>
        <View className="gap-3 px-2">
          <ThreadLoadingSkeleton width="34%" height={10} shimmerColor={shimmerColor} />
          <ThreadLoadingSkeleton shimmerColor={shimmerColor} />
          <ThreadLoadingSkeleton width="92%" shimmerColor={shimmerColor} />
          <ThreadLoadingSkeleton width="72%" shimmerColor={shimmerColor} />
        </View>
      </View>
    </View>
  );
}
