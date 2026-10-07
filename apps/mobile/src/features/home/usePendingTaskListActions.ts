import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Alert } from "react-native";

import { withThreadDismissal } from "./thread-dismissal";
import { appAtomRegistry } from "../../state/atom-registry";
import { removeThreadOutboxMessage } from "../../state/thread-outbox-removal";
import { clearComposerDraftContent } from "../../state/use-composer-drafts";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  dispatchingQueuedMessageIdAtom,
  holdDeletingQueuedMessage,
  releaseDeletingQueuedMessage,
} from "../../state/use-thread-outbox";

export function usePendingTaskListActions(): {
  readonly openPendingTask: (pendingTask: PendingNewTask) => void;
  readonly confirmDeletePendingTask: (pendingTask: PendingNewTask) => void;
} {
  const navigation = useNavigation();

  const openPendingTask = useCallback(
    (pendingTask: PendingNewTask) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(pendingTask.environmentId),
          projectId: String(pendingTask.projectId),
          ...(pendingTask.kind === "pending"
            ? { pendingTaskId: String(pendingTask.message.messageId) }
            : { draftId: pendingTask.draftKey }),
        },
      });
    },
    [navigation],
  );

  const confirmDeletePendingTask = useCallback((pendingTask: PendingNewTask) => {
    if (pendingTask.kind === "draft") {
      Alert.alert("Discard draft?", `“${pendingTask.title}” will be removed.`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            void withThreadDismissal(
              pendingTask.key,
              async () => {
                clearComposerDraftContent(pendingTask.draftKey, {
                  clearModelSelection: true,
                  clearWorkspaceSelection: true,
                });
                return true;
              },
              (result) => result,
            );
          },
        },
      ]);
      return;
    }
    Alert.alert(
      "Delete pending task?",
      `“${pendingTask.title}” has not been sent yet and will be removed from the outbox.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const messageId = pendingTask.message.messageId;
            if (!holdDeletingQueuedMessage(messageId)) {
              Alert.alert(
                "Pending task is open",
                "Close the pending task editor before deleting it.",
              );
              return;
            }
            void withThreadDismissal(
              pendingTask.key,
              async () => {
                const removed = await removeThreadOutboxMessage(
                  pendingTask.message,
                  undefined,
                  () => appAtomRegistry.get(dispatchingQueuedMessageIdAtom) !== messageId,
                );
                releaseDeletingQueuedMessage(messageId, removed);
                return removed;
              },
              (result) => result,
            ).catch((error) => {
              releaseDeletingQueuedMessage(messageId, false);
              Alert.alert(
                "Could not delete pending task",
                error instanceof Error ? error.message : "The pending task could not be removed.",
              );
            });
          },
        },
      ],
    );
  }, []);

  return { openPendingTask, confirmDeletePendingTask };
}
