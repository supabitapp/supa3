import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@supacode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import { CommandId, ThreadId, type EnvironmentId } from "@supacode/contracts";
import { useRef, useState } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../lib/uuid";
import { waitForThreadShellReady } from "../features/threads/threadForkNavigation";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreadShells } from "./threads";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export function useSendFeedback(environmentId: EnvironmentId | null) {
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const permitted = useAtomValue(serverEnvironment.startFeedback.permissionAtom(environmentId));
  const startFeedback = useAtomCommand(serverEnvironment.startFeedback, { reportFailure: false });
  const inFlight = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const available =
    config?.feedbackThreads === true && config.scratchWorkspaceRoot !== undefined && permitted;

  async function sendFeedback(targetEnvironmentId = environmentId) {
    if (
      targetEnvironmentId === null ||
      (targetEnvironmentId === environmentId && !available) ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setIsPending(true);
    try {
      const result = await startFeedback({
        environmentId: targetEnvironmentId,
        input: {
          commandId: CommandId.make(`feedback:${uuidv4()}`),
          threadId: ThreadId.make(uuidv4()),
        },
      });
      if (result._tag === "Success") {
        const threadRef = scopeThreadRef(targetEnvironmentId, result.value.threadId);
        const visible = await waitForThreadShellReady({
          read: () =>
            appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef)) !== null,
          timeoutMs: 5_000,
        });
        if (!visible) {
          Alert.alert(
            "Feedback thread created",
            "The thread has not reached this device yet. Open it from Threads when it appears.",
          );
          return;
        }
        navigation.navigate("Thread", {
          environmentId: targetEnvironmentId,
          threadId: result.value.threadId,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not start feedback",
          error instanceof Error ? error.message : "Try again.",
        );
      }
    } finally {
      inFlight.current = false;
      setIsPending(false);
    }
  }

  return { sendFeedback, isPending, available };
}
