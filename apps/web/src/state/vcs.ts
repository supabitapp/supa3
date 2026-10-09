import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@supacode/client-runtime/state/vcs";
import { createEnvironmentRpcCommand } from "@supacode/client-runtime/state/runtime";
import { WS_METHODS } from "@supacode/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
export const fetchVcsRefs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:vcs:fetch-refs",
  tag: WS_METHODS.vcsListRefs,
});
