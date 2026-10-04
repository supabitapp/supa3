import { View } from "react-native";

/** Static conversation shapes provide feedback without a continuously repainting shimmer. */
export function ThreadFeedLoading(props: {
  readonly topInset: number;
  readonly bottomInset: number;
  readonly horizontalPadding: number;
}) {
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
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View
          className="mb-7 self-end gap-2 rounded-2xl bg-user-bubble px-4 py-3"
          style={{ width: "70%" }}
        >
          <View className="h-2 rounded-full bg-foreground/10" />
          <View className="h-2 w-3/5 rounded-full bg-foreground/10" />
        </View>
        <View className="gap-3 px-2">
          <View className="h-2 w-4/5 rounded-full bg-foreground/10" />
          <View className="h-2 rounded-full bg-foreground/10" />
          <View className="h-2 w-3/5 rounded-full bg-foreground/10" />
        </View>
      </View>
    </View>
  );
}
