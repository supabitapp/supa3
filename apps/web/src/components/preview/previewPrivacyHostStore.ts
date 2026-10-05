import type { EnvironmentId } from "@supacode/contracts";
import { create } from "zustand";

type Registration = { readonly owner: object; readonly ready: boolean };
const usePrivacyHosts = create<{ byEnvironment: ReadonlyMap<EnvironmentId, Registration> }>(() => ({
  byEnvironment: new Map(),
}));

export function beginPreviewPrivacyHost(environmentId: EnvironmentId, owner: object): void {
  usePrivacyHosts.setState(({ byEnvironment }) => ({
    byEnvironment: new Map(byEnvironment).set(environmentId, { owner, ready: false }),
  }));
}

export function setPreviewPrivacyHostReady(
  environmentId: EnvironmentId,
  owner: object,
  ready: boolean,
): void {
  usePrivacyHosts.setState(({ byEnvironment }) => {
    const current = byEnvironment.get(environmentId);
    if (current?.owner !== owner || current.ready === ready) return { byEnvironment };
    return { byEnvironment: new Map(byEnvironment).set(environmentId, { owner, ready }) };
  });
}

export function usePreviewPrivacyHostReady(environmentId: EnvironmentId): boolean {
  return usePrivacyHosts((state) => state.byEnvironment.get(environmentId)?.ready ?? false);
}
