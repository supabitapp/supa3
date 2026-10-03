import { EnvironmentId } from "@supacode/contracts";
import { type EnvironmentConnectionPhase } from "@supacode/client-runtime/connection";

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;
