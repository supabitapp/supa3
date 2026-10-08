import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { inspectLoadBalancedEnvironments } from "@supacode/client-runtime/load-balancing";
import type { EnvironmentId } from "@supacode/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useContext, useEffect, useMemo } from "react";

import { serverEnvironment } from "../state/server";

const STATUS_LABELS = {
  checking: "Checking machines…",
  selected: "Selecting a machine…",
  "no-candidates": "No eligible machines",
  unavailable: "Resource checks unavailable",
  "at-capacity": "Waiting for capacity",
};

function hostResourcesSnapshotAtom(environmentIds: readonly EnvironmentId[]) {
  return Atom.make((get) => ({
    observedAt: Date.now(),
    resources: environmentIds.map((environmentId) => {
      const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
      return {
        environmentId,
        resources: result._tag === "Success" ? result.value : null,
        receivedAt: result._tag === "Success" ? result.timestamp : 0,
        pending: result._tag === "Initial" || result.waiting,
        failed: result._tag === "Failure",
      };
    }),
  }));
}

/** Only mounted for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  const refresh = useCallback(
    (ids: readonly EnvironmentId[]) => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    },
    [registry],
  );
  const resourcesAtom = useMemo(() => hostResourcesSnapshotAtom(environmentIds), [environmentIds]);
  const { observedAt, resources } = useAtomValue(resourcesAtom);
  const pending = resources.some((resource) => resource.pending);
  const selection = inspectLoadBalancedEnvironments(
    resources.map((resource) => ({
      ...resource,
      weight: weights[resource.environmentId] ?? 50,
    })),
    observedAt,
  );
  const environmentId = selection.environmentId as EnvironmentId | null;
  const status = pending ? "checking" : selection.status;
  useEffect(() => {
    if (environmentIds.length === 0 || pending || environmentId !== null) return;
    const timer = setTimeout(
      () => refresh(environmentIds),
      Math.max(0, observedAt + 5_000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [environmentIds, observedAt, pending, environmentId, refresh]);
  return {
    refresh,
    pending,
    environmentId,
    status,
    label: STATUS_LABELS[status],
    failed: !pending && environmentId === null && resources.some((resource) => resource.failed),
  };
}
