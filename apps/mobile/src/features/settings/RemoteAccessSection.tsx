import {
  remoteAccessStatusLabel,
  remoteAccessFailureMessage,
} from "@supacode/client-runtime/state/remote-access";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@supacode/contracts";
import { squashAtomCommandFailure } from "@supacode/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { remoteAccess } from "../../state/remote-access";
import { useAtomCommand } from "../../state/use-atom-command";
import { createNewTaskDraft, setComposerDraftText } from "../../state/use-composer-drafts";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function RemoteAccessSection({
  environmentId,
  scopes,
}: {
  readonly environmentId: EnvironmentId;
  readonly scopes: readonly AuthEnvironmentScope[] | null;
}) {
  const navigation = useNavigation();
  const statusAtom = remoteAccess.statusAtom({ environmentId, input: {} });
  const result = useAtomValue(statusAtom);
  const setup = useAtomValue(remoteAccess.setupAtom({ environmentId, input: {} }));
  const status = AsyncResult.isSuccess(result) ? result.value : null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const setEnabled = useAtomCommand(remoteAccess.setEnabled, { reportFailure: false });
  const repair = useAtomCommand(remoteAccess.repair, { reportFailure: false });
  const remove = useAtomCommand(remoteAccess.remove, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = scopes?.includes(AuthAccessWriteScope) ?? false;
  const canSetup = scopes?.includes(AuthOrchestrationOperateScope) ?? false;
  async function perform(action: () => ReturnType<typeof repair>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remote access could not be updated.");
    } finally {
      setPending(false);
      appAtomRegistry.refresh(statusAtom);
    }
  }
  function openSetup(project: (typeof projects)[number]) {
    if (!AsyncResult.isSuccess(setup)) return;
    const draftId = createNewTaskDraft({ environmentId, projectId: project.id });
    setComposerDraftText(draftId, setup.value.prompt);
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: { environmentId, projectId: project.id, draftId },
    });
  }
  if (status?.state === "relay-mode") return null;
  const configured = status?.accountId != null;
  return (
    <SettingsSection title="Remote access">
      <View className="gap-2 p-4">
        <Text className="text-lg">Your Cloudflare account</Text>
        <Text className="text-sm text-foreground-muted">
          {(status ? remoteAccessStatusLabel(status) : null) ?? "Unavailable on this server"}. Setup
          needs a domain in Cloudflare DNS. Credentials stay on the host.
        </Text>
        {status?.publicUrl ? (
          <Text selectable className="text-sm">
            {status.publicUrl}
          </Text>
        ) : null}
      </View>
      {!configured || status?.state === "needs-login" ? (
        <SettingsActionRow
          icon="bolt.horizontal.circle"
          label="Set up with my agent"
          disabled={
            !canSetup ||
            !status ||
            projects.length === 0 ||
            !AsyncResult.isSuccess(setup) ||
            pending
          }
          onPress={() => {
            if (projects.length === 1) openSetup(projects[0]!);
            else
              Alert.alert(
                "Choose a project on this host",
                "Open a prepared conversation, then send it to your agent.",
                [
                  ...projects
                    .slice(0, 8)
                    .map((project) => ({ text: project.title, onPress: () => openSetup(project) })),
                  { text: "Cancel", style: "cancel" },
                ],
              );
          }}
        />
      ) : null}
      {configured && status?.state !== "cleanup-pending" ? (
        <>
          <SettingsActionRow
            icon="play"
            label={status?.enabled ? "Disable" : "Enable"}
            disabled={!writable || pending}
            onPress={() =>
              void perform(() =>
                setEnabled({ environmentId, input: { enabled: !status?.enabled } }),
              )
            }
          />
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Repair"
            disabled={!writable || pending}
            onPress={() => void perform(() => repair({ environmentId, input: {} }))}
          />
        </>
      ) : null}
      {configured ? (
        <SettingsActionRow
          icon="trash"
          tone="danger"
          label={status?.state === "cleanup-pending" ? "Retry removal" : "Remove remote access"}
          disabled={!writable || pending}
          onPress={() =>
            Alert.alert(
              "Remove remote access?",
              "Delete this installation's Cloudflare tunnel and DNS record. Your login and other resources are retained.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () => void perform(() => remove({ environmentId, input: {} })),
                },
              ],
            )
          }
        />
      ) : null}
      {error || status?.failure ? (
        <View className="p-4">
          <Text className="text-sm text-danger-foreground">
            {error ?? remoteAccessFailureMessage(status?.failure ?? null)}
          </Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}
