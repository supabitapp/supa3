import * as Encoding from "effect/Encoding";
import { CheckpointRef, type ThreadId } from "@supacode/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/supacode/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}
