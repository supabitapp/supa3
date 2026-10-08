import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import type { EnvironmentId } from "@supacode/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProjects } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import {
  drainThreadCreations,
  reloadThreadCreations,
  setThreadCreationReason,
  useThreadCreations,
} from "../state/threadCreationQueue";
import { subscribeThreadOutboxStorage } from "../state/threadOutboxStorage";

export function ThreadCreationCoordinator() {
  const entries = useThreadCreations();
  const projects = useProjects();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const settings = useClientSettings();
  const hydrated = useClientSettingsHydrated();

  useEffect(() => {
    void reloadThreadCreations().catch(console.error);
    return subscribeThreadOutboxStorage(() => {
      void reloadThreadCreations().catch(console.error);
    });
  }, []);

  useEffect(() => {
    if (!hydrated || entries.length === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const disposals: Array<() => void> = [];
    const mounted = new Set<EnvironmentId>();
    const readResources = (environmentId: EnvironmentId) => {
      const atom = serverEnvironment.hostResources({ environmentId, input: {} });
      if (!mounted.has(environmentId)) {
        mounted.add(environmentId);
        disposals.push(appAtomRegistry.mount(atom));
      }
      const result = appAtomRegistry.get(atom);
      return {
        resources: result._tag === "Success" ? result.value : null,
        receivedAt: result._tag === "Success" ? result.timestamp : 0,
      };
    };
    const run = () => {
      void drainThreadCreations({
        entries,
        projects,
        configs,
        weights: settings.loadBalancingWeights,
        isConnected: (environmentId) =>
          presentations.get(environmentId)?.connection.phase === "connected" &&
          appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status === "live",
        readResources,
        isActive: () => !stopped,
      })
        .catch((cause: unknown) => {
          console.error("[thread-creation] Could not resolve queued tasks", cause);
          for (const entry of entries)
            setThreadCreationReason(entry.id, "Could not check machines. Retrying.");
        })
        .finally(() => {
          if (stopped) return;
          timer = setTimeout(() => {
            for (const environmentId of mounted)
              appAtomRegistry.refresh(
                serverEnvironment.hostResources({ environmentId, input: {} }),
              );
            run();
          }, 5_000);
        });
    };
    run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const dispose of disposals) dispose();
    };
  }, [entries, projects, presentations, configs, hydrated, settings]);

  return null;
}
