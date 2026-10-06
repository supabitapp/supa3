import {
  remoteAccessStatusLabel,
  remoteAccessFailureMessage,
} from "@supacode/client-runtime/state/remote-access";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@supacode/contracts";
import { scopeProjectRef } from "@supacode/client-runtime/environment";
import { squashAtomCommandFailure } from "@supacode/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { remoteAccess } from "../../state/remoteAccess";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function RemoteAccessSettings({
  environmentId,
  scopes,
}: {
  readonly environmentId: EnvironmentId;
  readonly scopes: readonly AuthEnvironmentScope[] | null;
}) {
  const statusAtom = remoteAccess.statusAtom({ environmentId, input: {} });
  const result = useAtomValue(statusAtom);
  const status = AsyncResult.isSuccess(result) ? result.value : null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState("");
  const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0];
  const newThread = useNewThreadHandler();
  const setEnabled = useAtomCommand(remoteAccess.setEnabled, { reportFailure: false });
  const repair = useAtomCommand(remoteAccess.repair, { reportFailure: false });
  const remove = useAtomCommand(remoteAccess.remove, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const writable = scopes?.includes(AuthAccessWriteScope) ?? false;
  const canSetUp = scopes?.includes(AuthOrchestrationOperateScope) ?? false;

  async function perform(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remote access could not be updated.");
    } finally {
      setPending(false);
      appAtomRegistry.refresh(statusAtom);
    }
  }
  async function setup() {
    if (!selectedProject) return;
    const prompt = await appAtomRegistry.get(remoteAccess.setupAtom({ environmentId, input: {} }));
    if (!AsyncResult.isSuccess(prompt))
      throw new Error("Setup instructions are loading. Try again.");
    const draft = await newThread(scopeProjectRef(environmentId, selectedProject.id), {
      envMode: "local",
    });
    if (draft) useComposerDraftStore.getState().setPrompt(draft.draftId, prompt.value.prompt);
  }
  function ensureSuccess(result: Awaited<ReturnType<typeof repair>>) {
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }
  // Keep the versioned prompt subscribed while this panel is open.
  useAtomValue(remoteAccess.setupAtom({ environmentId, input: {} }));
  if (status?.state === "relay-mode") return null;
  const configured = status?.accountId !== null && status?.accountId !== undefined;
  return (
    <SettingsSection title="Remote access">
      <SettingsRow
        title="Your Cloudflare account"
        description="Connect from anywhere through a persistent tunnel in your account. Setup needs a domain in Cloudflare DNS. Credentials stay on the host."
        status={
          (status ? remoteAccessStatusLabel(status) : null) ??
          (AsyncResult.isFailure(result) ? "Unavailable on this server" : "Loading")
        }
      />
      {configured && status?.publicUrl ? (
        <SettingsRow title="Address" description={status.publicUrl} />
      ) : null}
      {!configured || status?.state === "needs-login" ? (
        <SettingsRow
          title="Set up with my agent"
          description={
            projects.length === 0
              ? "Add a project on this environment to start setup."
              : "Open a prepared conversation, then send it to your agent. Cloudflare handles sign-in."
          }
          control={
            <div className="flex items-center gap-2">
              {projects.length > 1 ? (
                <select
                  aria-label="Remote setup project"
                  value={selectedProject?.id ?? ""}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                size="sm"
                disabled={!canSetUp || !status || !selectedProject || pending}
                onClick={() => void perform(setup)}
              >
                Set up with my agent
              </Button>
            </div>
          }
        />
      ) : null}
      {configured ? (
        <SettingsRow
          title="Manage remote access"
          description="Disabling keeps your address. Removal deletes this installation's tunnel and DNS record. Your Cloudflare login is retained."
          control={
            <div className="flex flex-wrap gap-2">
              {status?.state !== "cleanup-pending" ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!writable || pending}
                    onClick={() =>
                      void perform(async () =>
                        ensureSuccess(
                          await setEnabled({ environmentId, input: { enabled: !status?.enabled } }),
                        ),
                      )
                    }
                  >
                    {status?.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!writable || pending}
                    onClick={() =>
                      void perform(async () =>
                        ensureSuccess(await repair({ environmentId, input: {} })),
                      )
                    }
                  >
                    Repair
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={!writable || pending}
                onClick={() => {
                  if (!confirmRemove) {
                    setConfirmRemove(true);
                    return;
                  }
                  void perform(async () => {
                    ensureSuccess(await remove({ environmentId, input: {} }));
                    setConfirmRemove(false);
                  });
                }}
              >
                {confirmRemove
                  ? "Confirm removal"
                  : status?.state === "cleanup-pending"
                    ? "Retry removal"
                    : "Remove"}
              </Button>
              {confirmRemove ? (
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          }
        />
      ) : null}
      {status?.ready ? (
        <SettingsRow
          title="Ready to pair"
          description="Create a pairing link below and choose Cloudflare in the QR menu."
        />
      ) : null}
      {error || status?.failure ? (
        <p className="text-sm text-destructive">
          {error ?? remoteAccessFailureMessage(status?.failure ?? null)}
        </p>
      ) : null}
    </SettingsSection>
  );
}
