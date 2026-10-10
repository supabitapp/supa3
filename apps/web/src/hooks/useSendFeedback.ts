import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@supacode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import { CommandId } from "@supacode/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId, randomUUID } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";

export function useSendFeedback() {
  const router = useRouter();
  const target = resolveThreadRouteTarget(useParams({ strict: false }));
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const draftEnvironmentId = useComposerDraftStore((store) =>
    target?.kind === "draft"
      ? (store.getDraftSession(target.draftId)?.environmentId ?? null)
      : null,
  );
  const { environments } = useEnvironments();
  const environmentId =
    target?.kind === "server"
      ? target.threadRef.environmentId
      : (draftEnvironmentId ?? primaryEnvironmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const permitted = useAtomValue(serverEnvironment.startFeedback.permissionAtom(environmentId));
  const startFeedback = useAtomCommand(serverEnvironment.startFeedback, { reportFailure: false });
  const inFlight = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const unavailableReason =
    environment?.connection.phase !== "connected"
      ? "Connect an environment to send feedback"
      : environment.serverConfig?.feedbackThreads !== true
        ? "Update this environment's server to send feedback"
        : environment.serverConfig.scratchWorkspaceRoot === undefined
          ? "Threads without a project are unavailable on this environment"
          : !permitted
            ? "You need permission to start threads to send feedback"
            : null;

  async function sendFeedback() {
    if (environmentId === null || unavailableReason !== null || inFlight.current) return;
    inFlight.current = true;
    setIsPending(true);
    try {
      const composer = target
        ? useComposerDraftStore
            .getState()
            .getComposerDraft(target.kind === "draft" ? target.draftId : target.threadRef)
        : null;
      const composerModelSelection = composer?.activeProvider
        ? composer.modelSelectionByProvider[composer.activeProvider]
        : undefined;
      const modelSelection =
        composerModelSelection ??
        (target?.kind === "server" ? readThreadShell(target.threadRef)?.modelSelection : undefined);
      const result = await startFeedback({
        environmentId,
        input: {
          commandId: CommandId.make(`feedback:${randomUUID()}`),
          threadId: newThreadId(),
          ...(modelSelection ? { modelSelection } : {}),
        },
      });
      if (result._tag === "Success") {
        const threadRef = scopeThreadRef(environmentId, result.value.threadId);
        if (!(await waitForThreadShell(threadRef))) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Feedback thread created",
              description:
                "The thread has not reached this device yet. Open it from Threads when it appears.",
            }),
          );
          return;
        }
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start feedback",
            description: error instanceof Error ? error.message : "Try again.",
          }),
        );
      }
    } finally {
      inFlight.current = false;
      setIsPending(false);
    }
  }

  return { sendFeedback, isPending, unavailableReason };
}
