// @effect-diagnostics nodeBuiltinImport:off - this typed notification bridges an existing process rejection guard to scoped telemetry.
import * as NodeEvents from "node:events";

/** Fatal rejection notification for guards that explicitly exit instead of using Node's default handler. */
export const fatalRejections = new NodeEvents.EventEmitter<{ rejection: [reason: unknown] }>();
