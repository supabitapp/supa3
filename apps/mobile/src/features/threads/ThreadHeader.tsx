import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenHeaderButton } from "../../components/ScreenHeaderButton";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";

import type { ScreenHeaderMenu, ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const navigation = useNavigation();
  const { layout, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  const androidHeaderMenu = useMemo<ScreenHeaderMenu>(() => {
    const items: ScreenHeaderMenuItem[] = [];
    if (props.hasWorkspaceRoot) {
      items.push({
        id: "thread-terminal",
        title: "Terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    if (props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      items.push({
        id: "thread-files",
        title: filesVisible ? "Close files" : "Files",
        selected: filesVisible,
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    items.push({
      id: "thread-git",
      title: "Git",
      onPress: props.onOpenGitInspector,
    });
    if (onMergeBack) {
      items.push({
        id: "thread-merge-back",
        title: "Merge back to source",
        onPress: onMergeBack,
      });
    }
    return { title: "More actions", icon: "ellipsis", items };
  }, [
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
  ]);

  return (
    <>
      <ScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        options={native.options}
        optionsVersion={native.optionsVersion}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={
          layout.usesSplitView
            ? undefined
            : () => {
                if (navigation.canGoBack()) navigation.goBack();
                else navigation.dispatch(StackActions.replace("Home"));
              }
        }
        actions={
          props.onReturnToThread
            ? [
                {
                  accessibilityLabel: "Return to chat",
                  icon: "chevron.left",
                  onPress: props.onReturnToThread,
                },
              ]
            : undefined
        }
        menus={[androidHeaderMenu]}
        hideBottomBorder
      />
      {native.fallback}
    </>
  );
}
