import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, type ThreadId } from "@supacode/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/supacode/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}
