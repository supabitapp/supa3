import { SignInButton, UserButton, useAuth } from "@clerk/react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@supacode/client-runtime/connection";
import { EnvironmentId } from "@supacode/contracts";
import { useState } from "react";
import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";
import { useManagedRelayEnvironments } from "./managedRelayState";
import { useCloudLinkController } from "./useCloudLinkController";
import { resolveCloudPublicConfig } from "./publicConfig";
import { Button } from "../components/ui/button";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";

export default function RelayAccountSettings() {
  const { isSignedIn } = useAuth();
  const controller = useCloudLinkController();
  const environments = useManagedRelayEnvironments();
  const register = useAtomCommand(environmentCatalog.register);
  const [pending, setPending] = useState(false);
  return (
    <SettingsSection title="Relay account">
      <SettingsRow
        title="Your relay"
        description={resolveCloudPublicConfig().relayUrl}
        control={
          isSignedIn ? (
            <UserButton />
          ) : (
            <SignInButton mode="modal">
              <Button size="sm">Sign in</Button>
            </SignInButton>
          )
        }
      />
      {isSignedIn ? (
        <>
          <SettingsRow
            title="Connect this environment"
            description="Link this host to your own relay deployment."
            control={
              <Button
                size="sm"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    await controller.reconcileCloudState({
                      managedTunnel: !controller.managedTunnelActive,
                      publish: false,
                    });
                    environments.refresh();
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {controller.managedTunnelActive ? "Unlink" : "Link"}
              </Button>
            }
          />
          {environments.data?.map((environment) => (
            <SettingsRow
              key={environment.environmentId}
              title={environment.label}
              control={
                <Button
                  size="sm"
                  onClick={() =>
                    void register(
                      new RelayConnectionRegistration({
                        target: new RelayConnectionTarget({
                          environmentId: EnvironmentId.make(environment.environmentId),
                          label: environment.label,
                        }),
                      }),
                    )
                  }
                >
                  Connect
                </Button>
              }
            />
          ))}
        </>
      ) : null}
      {controller.operationError || environments.error ? (
        <p className="text-sm text-destructive">
          {controller.operationError ?? environments.error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
