import { useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { WebView } from "react-native-webview";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { AppText as Text } from "../../components/AppText";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import { LoadingStrip } from "../../components/LoadingStrip";

export function WorkspaceFileWebPreview(props: { readonly uri: string | null }) {
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const headerInsetTop = Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (props.uri === null) {
    return <FilePreviewLoading message="Preparing preview..." background="card" />;
  }

  return (
    <View className="relative flex-1 bg-card">
      {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
      {loadError ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-xs font-supacode-bold text-foreground">Preview failed</Text>
          <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
        </View>
      ) : null}
      <WebView
        source={{ uri: props.uri }}
        contentInsetAdjustmentBehavior="never"
        contentInset={{ top: headerInsetTop }}
        originWhitelist={["*"]}
        allowsBackForwardNavigationGestures
        allowsFullscreenVideo
        setSupportMultipleWindows={false}
        startInLoadingState
        onLoadProgress={(event) => {
          setLoadProgress(event.nativeEvent.progress);
        }}
        onLoadStart={() => {
          setLoadProgress(0.05);
          setLoadError(null);
        }}
        onLoadEnd={() => {
          setLoadProgress(0);
        }}
        onError={(event) => {
          setLoadProgress(0);
          setLoadError(event.nativeEvent.description || "The file could not be rendered.");
        }}
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center bg-card">
            <ActivityIndicator />
          </View>
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
