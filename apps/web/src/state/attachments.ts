import {
  createAttachmentEnvironmentAtoms,
  isAssetAttachmentNotFoundFailure,
} from "@supacode/client-runtime/state/attachments";
import { resolveAssetUrl } from "@supacode/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@supacode/client-runtime/state/runtime";
import { createConcurrencyLimiter } from "../lib/concurrencyLimiter";
import {
  AuthOrchestrationReadScope,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
} from "@supacode/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "./assets";
import { readEnvironmentScope, readPreparedConnection } from "./session";
import {
  downloadAttachmentBytes,
  AttachmentSourceMissingError,
} from "../lib/downloadAttachmentBytes";

export const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime);

const limitRecoveries = createConcurrencyLimiter(2);

export function recoverAttachmentSource(input: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly signal: AbortSignal;
}): Promise<File> {
  return limitRecoveries(async () => {
    input.signal.throwIfAborted();
    const connection = readPreparedConnection(input.environmentId);
    if (!connection) throw new Error("Connect to the original machine to recover this attachment.");
    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationReadScope))
      throw new Error("This connection cannot read the original attachment.");
    const result = await executeAtomQuery(
      appAtomRegistry,
      assetEnvironment.createUrl({
        environmentId: input.environmentId,
        input: { resource: { _tag: "attachment", attachmentId: input.attachmentId } },
      }),
      { signal: input.signal, reportFailure: false, reportDefect: false, refresh: true },
    );
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      if (isAssetAttachmentNotFoundFailure(error)) throw new AttachmentSourceMissingError();
      throw new Error(
        "The original attachment could not be read. Retry when the machine reconnects.",
      );
    }
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The original attachment URL is unavailable.");
    const file = await downloadAttachmentBytes({
      url,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      maxBytes:
        input.type === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    if (readPreparedConnection(input.environmentId) !== connection)
      throw new Error("The source connection changed. Retry the attachment.");
    return file;
  });
}
