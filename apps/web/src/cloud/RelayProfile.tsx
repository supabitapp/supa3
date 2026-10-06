import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";
import { resolveCloudPublicConfig } from "./publicConfig";
import { ManagedRelayAuthProvider } from "./managedAuth";

export default function RelayProfile({ children }: { readonly children: ReactNode }) {
  const key = resolveCloudPublicConfig().clerkPublishableKey;
  if (!key) return children;
  return (
    <ClerkProvider publishableKey={key}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
