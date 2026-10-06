import { createRemoteAccessAtoms } from "@supacode/client-runtime/state/remote-access";
import { connectionAtomRuntime } from "../connection/runtime";
export const remoteAccess = createRemoteAccessAtoms(connectionAtomRuntime);
