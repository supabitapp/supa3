import { draftAttachmentRequirement } from "../composerAttachmentState";
import {
  firstAttachmentPlacementBlockReason,
  automaticAttachmentPlacementBlockReason,
  type AttachmentRequirement,
} from "@supacode/client-runtime/state/attachments";
import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@supacode/contracts";
import { useMemo, useCallback } from "react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { environmentSession, useEnvironmentsWithScope } from "../state/session";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { useShallow } from "zustand/react/shallow";

export function attachmentDestination(
  environment: Pick<EnvironmentPresentation, "environmentId" | "serverConfig">,
  canUpload: boolean,
) {
  const config = environment.serverConfig;
  return {
    environmentId: environment.environmentId,
    canUpload,
    uploads: config ? config.environment.capabilities.attachmentUploads === true : null,
    maxFileBytes: config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  };
}

function createDraftAttachmentSelector(
  target: ComposerThreadTarget,
  readable: ReadonlySet<EnvironmentId>,
) {
  let previous: ReadonlyArray<AttachmentRequirement> = [];
  let previousKey = "[]";
  return (store: ReturnType<typeof useComposerDraftStore.getState>) => {
    const draft = store.getComposerDraft(target);
    const next = [...(draft?.images ?? []), ...(draft?.files ?? [])].map((attachment) =>
      draftAttachmentRequirement(attachment, (id) => readable.has(id)),
    );
    const key = JSON.stringify(next);
    if (key !== previousKey) {
      previous = next;
      previousKey = key;
    }
    return previous;
  };
}

function useReadableAttachmentEnvironments(ids: ReadonlyArray<EnvironmentId>) {
  const environments = useMemo(() => ids.map((environmentId) => ({ environmentId })), [ids]);
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const connectedAtom = useMemo(
    () =>
      Atom.make(
        (get) =>
          new Set(
            environments
              .filter(({ environmentId }) =>
                Option.isSome(get(environmentSession.preparedConnectionValueAtom(environmentId))),
              )
              .map(({ environmentId }) => environmentId),
          ),
      ),
    [environments],
  );
  const connected = useAtomValue(connectedAtom);
  return useMemo(
    () => new Set([...permitted].filter((id) => connected.has(id))),
    [permitted, connected],
  );
}

export function useDraftAttachmentPlacement(target: ComposerThreadTarget) {
  const sourceIds = useComposerDraftStore(
    useShallow((store) => [
      ...new Set(
        (store.getComposerDraft(target)?.files ?? []).flatMap((file) =>
          file.uploadEnvironmentId ? [file.uploadEnvironmentId] : [],
        ),
      ),
    ]),
  );
  const readable = useReadableAttachmentEnvironments(sourceIds);
  const selectRequirements = useMemo(
    () => createDraftAttachmentSelector(target, readable),
    [target, readable],
  );
  const requirements = useComposerDraftStore(selectRequirements);
  const { environments } = useEnvironments();
  const uploadable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const destinations = useMemo(
    () =>
      new Map(
        environments.map((environment) => {
          return [
            environment.environmentId,
            {
              connected: environment.connection.phase === "connected",
              destination: attachmentDestination(
                environment,
                uploadable.has(environment.environmentId),
              ),
            },
          ];
        }),
      ),
    [environments, uploadable],
  );
  const blockReason = useCallback(
    (environmentId: EnvironmentId) => {
      if (requirements.length === 0) return null;
      const destination = destinations.get(environmentId)?.destination;
      if (!destination) return "Connect to a machine with attachment support.";
      return firstAttachmentPlacementBlockReason(requirements, destination);
    },
    [requirements, destinations],
  );
  const autoBlockReason = useCallback(
    (ids: ReadonlyArray<EnvironmentId>) =>
      automaticAttachmentPlacementBlockReason(
        requirements,
        ids.flatMap((id) => {
          const candidate = destinations.get(id);
          return candidate ? [candidate] : [];
        }),
      ),
    [requirements, destinations],
  );
  return { blockReason, autoBlockReason };
}
