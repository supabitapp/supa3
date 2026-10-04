import { useInlineConfirm } from "~/hooks/useInlineConfirm";

import { InlineConfirmLabel } from "../InlineConfirm";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function RestoreThreadBranchButton(props: {
  readonly branch: string;
  readonly hasUncommittedChanges: boolean;
  readonly restoring: boolean;
  readonly onRestore: () => void;
}) {
  const confirm = useInlineConfirm<"restore">();
  const armed = confirm.armed === "restore";
  return (
    <Tooltip>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <Button
            size="xs"
            variant="ghost"
            disabled={props.restoring}
            {...(props.hasUncommittedChanges
              ? confirm.bind("restore", props.onRestore)
              : { onClick: props.onRestore })}
          />
        }
      >
        <InlineConfirmLabel
          armed={armed}
          idle={props.restoring ? "Restoring..." : "Restore branch"}
          confirm="Confirm restore"
        />
      </TooltipTrigger>
      <TooltipPopup key={armed ? "armed" : "idle"} side="top">
        {armed
          ? `Click again to switch to ${props.branch}. Your uncommitted changes will carry over, or block the switch if they conflict.`
          : props.hasUncommittedChanges
            ? `Switch back to ${props.branch}. You have uncommitted changes.`
            : `Switch back to ${props.branch}`}
      </TooltipPopup>
    </Tooltip>
  );
}
