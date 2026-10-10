import { StackActions, useNavigation } from "@react-navigation/native";
import { buildFeedbackPrompt } from "@supacode/client-runtime/feedback-prompt";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import type { EnvironmentId } from "@supacode/contracts";
import Constants from "expo-constants";
import { useRef, useState } from "react";
import { Alert, Platform } from "react-native";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

export function useSendFeedback() {
  const navigation = useNavigation();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const inFlight = useRef(false);
  const [isPending, setIsPending] = useState(false);

  async function sendFeedback(target: {
    readonly environmentId: EnvironmentId;
    readonly serverVersion: string;
  }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsPending(true);
    try {
      const result = await openScratch({ environmentId: target.environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not start feedback",
            error instanceof Error ? error.message : "Try again.",
          );
        }
        return;
      }
      const project = result.value;
      await waitForComposerDraftsLoaded();
      const draftKey = createNewTaskDraft({
        environmentId: project.environmentId,
        projectId: project.id,
      });
      setComposerDraftText(
        draftKey,
        buildFeedbackPrompt({
          serverVersion: target.serverVersion,
          client: `${Platform.OS === "ios" ? "iOS" : "Android"} app ${Constants.expoConfig?.version ?? "0.0.0"}`,
        }),
      );
      let root = navigation;
      for (let parent = root.getParent(); parent; parent = parent.getParent()) {
        root = parent;
      }
      root.dispatch(
        StackActions.replace("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            draftId: draftKey,
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        }),
      );
    } finally {
      inFlight.current = false;
      setIsPending(false);
    }
  }

  return { sendFeedback, isPending };
}
