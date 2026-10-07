import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@supacode/contracts";
import type { AsyncResult } from "effect/reactivity";
import { environmentSession } from "~/state/session";
import type {
  EnvironmentId,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@supacode/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@supacode/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import { CircleArrowUpIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment, updateOutdatedServer } from "~/state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand } from "~/versionSkew";
import { Button } from "./ui/button";
import { InlineConfirmButton } from "./InlineConfirm";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The wire "installing" stage is a sub-second launcher handoff, so the UI
// folds it into the download phase; everything after the handoff is the
// restart the user is actually waiting through.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Downloading…",
  resuming: "Restarting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly installation?: ServerInstallation | undefined;
  readonly desktopAppUpdate?: boolean;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  readonly label?: string;
  /** "icon" renders a compact icon button with the label in a tooltip. */
  readonly appearance?: "button" | "icon";
};

function useServerUpdate() {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  return async (target: ServerUpdateTarget, failureTitle = "Server update failed") => {
    const { environmentId, serverLabel, selfUpdate, targetVersion } = target;
    if (
      !canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId))) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    )
      return;
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await updateServer({
        environmentId,
        input: {
          targetVersion,
          ...(target.threadContinuation && target.continueThreadsAfterServerUpdate
            ? { continueRunningThreads: true }
            : {}),
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description:
          selfUpdate === "desktop-managed"
            ? `Desktop app relaunched on ${result.value.targetVersion}.`
            : `Reconnected on supacode@${result.value.targetVersion}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: updateFailureMessage(error),
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
}

/** Updates eligible machines independently; manual paths remain in the machine list. */
export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
  className,
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const update = useServerUpdate();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(
    (target) =>
      target.selfUpdate !== null &&
      (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate),
  );
  const desktopTargets = eligible.filter((target) => target.selfUpdate === "desktop-managed");
  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const available = eligible.filter(
        (target) => !pendingUpdateEnvironmentIds.has(target.environmentId),
      );
      await Promise.all(
        available.map((target) => update(target, `${target.serverLabel} update failed`)),
      );
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return (
    <InlineConfirmButton
      key={desktopTargets
        .map((target) => `${target.environmentId}:${target.targetVersion}`)
        .join(",")}
      size={size}
      variant={variant}
      className={className}
      disabled={isPending || eligible.length === 0}
      required={desktopTargets.length > 0}
      label={label}
      confirmLabel="Confirm update all"
      tooltip={label}
      confirmTooltip={`Click again to update the desktop apps on ${desktopTargets.map((target) => target.serverLabel).join(", ")}. They will close and relaunch on those machines. Running threads may be interrupted.`}
      onConfirm={() => void handleUpdate()}
    />
  );
}

function canUpdateServer(result: AsyncResult.AsyncResult<AuthSessionState, unknown>): boolean {
  if (result._tag !== "Success" || !result.value.authenticated) return false;
  return sessionGrantsScope(result.value, AuthEnvironmentMaintainScope);
}

/**
 * One-row status for an in-flight server update: "Downloading…" then
 * "Restarting…". The update is a wait, not a warning: a single pulsing dot
 * and label, no step rail, no versions. Failure turns the row red with the
 * rollback reason.
 */
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top">{state.message}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  installation,
  desktopAppUpdate = false,
  threadContinuation = false,
  targetVersion,
  label = "Update",
  variant = "outline",
  size = "xs",
  className,
  appearance = "button",
}: Omit<ServerUpdateTarget, "continueThreadsAfterServerUpdate"> & UpdateButtonProps) {
  const isDesktopAppUpdate = selfUpdate === "desktop-managed";
  const sessionStateAtom = environmentSession.sessionStateAtom(environmentId);
  const canUpdate = canUpdateServer(useAtomValue(sessionStateAtom));
  const continueThreadsAfterServerUpdate = useEnvironmentSettings(
    environmentId,
    (settings) => settings.continueThreadsAfterServerUpdate,
  );
  const update = useServerUpdate();
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: installation?.kind === "npm-global" ? "update command" : "relaunch command",
    onCopy: ({ command }) => {
      toastManager.add({
        type: "success",
        title:
          installation?.kind === "npm-global" ? "Update command copied" : "Relaunch command copied",
        description:
          installation?.kind === "npm-global"
            ? `Run \`${command}\` on ${serverLabel}, then restart supacode with your usual options.`
            : `Stop supacode on ${serverLabel}, then relaunch with \`${command}\` using the same subcommand and options. This does not update an installed supacode command.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy update command",
        description: error.message,
      });
    },
  });

  const handleUpdate = async () => {
    if (
      !canUpdateServer(appAtomRegistry.get(sessionStateAtom)) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    ) {
      return;
    }
    await update({
      environmentId,
      serverLabel,
      selfUpdate,
      desktopAppUpdate,
      threadContinuation,
      targetVersion,
      continueThreadsAfterServerUpdate,
    });
  };

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  const manualCommand =
    selfUpdate === null ? manualServerUpdateCommand(targetVersion, installation) : null;
  const actionLabel =
    manualCommand !== null
      ? installation?.kind === "npm-global"
        ? "Copy update command"
        : "Copy relaunch command"
      : label;
  const onClick =
    manualCommand !== null
      ? () => copyToClipboard(manualCommand, { command: manualCommand })
      : () => void handleUpdate();

  if (isDesktopAppUpdate) {
    return (
      <InlineConfirmButton
        key={`${environmentId}:${targetVersion}`}
        size={appearance === "icon" ? "icon-xs" : size}
        variant={appearance === "icon" ? "ghost-muted" : variant}
        className={className}
        disabled={!canUpdate}
        icon={appearance === "icon" ? <CircleArrowUpIcon className="size-3.5" /> : undefined}
        label={appearance === "icon" ? `${actionLabel} for ${serverLabel}` : actionLabel}
        confirmLabel={
          appearance === "icon" ? `Confirm update for ${serverLabel}` : "Confirm update"
        }
        tooltip={actionLabel}
        confirmTooltip={`Click again to update the desktop app on ${serverLabel}. It will close and relaunch on that machine. Running threads may be interrupted.`}
        onConfirm={onClick}
      />
    );
  }

  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className={className}
              aria-label={`${actionLabel} for ${serverLabel}`}
              disabled={manualCommand === null && !canUpdate}
              onClick={onClick}
            />
          }
        >
          <CircleArrowUpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{actionLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={manualCommand === null && !canUpdate}
      onClick={onClick}
    >
      {actionLabel}
    </Button>
  );
}

/**
 * Updates a host too old for this client to connect to. Its version comes
 * from the host descriptor because the host never delivers a server config.
 */
export function OutdatedServerUpdateAction({
  environmentId,
  serverLabel,
  fromVersion,
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await update({
        environmentId,
        input: { targetVersion },
        ...(fromVersion === undefined ? {} : { fromVersion }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description: `Reconnected on supacode@${result.value.targetVersion}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Server update failed",
        description: updateFailureMessage(error),
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
  return (
    <Button size="xs" variant="outline" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
