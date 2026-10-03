import type { VcsRef } from "@t3tools/contracts";

export function resolveDefaultWorktreeBaseBranch(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current" | "isRemote">>,
): string | null {
  return (
    refs.find((ref) => ref.isDefault)?.name ??
    refs.find((ref) => ref.current && !ref.isRemote)?.name ??
    null
  );
}
