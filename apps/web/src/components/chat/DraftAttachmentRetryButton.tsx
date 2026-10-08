import { RefreshCwIcon } from "lucide-react";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadTarget,
} from "../../composerDraftStore";
import { retryComposerDraftAttachments } from "../../composerDraftAttachments";
import { draftAttachmentRetry } from "../../composerAttachmentState";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function DraftAttachmentRetryButton(props: {
  attachment: ComposerFileAttachment | ComposerImageAttachment;
  target: ComposerThreadTarget;
  variant: "overlay" | "ghost";
}) {
  const retry = draftAttachmentRetry(props.attachment);
  if (!retry) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.variant}
            size="icon-xs"
            onClick={() => {
              void retryComposerDraftAttachments(props.target, [props.attachment.id]);
            }}
            aria-label={`${retry.label} ${props.attachment.name}`}
          >
            <RefreshCwIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">{retry.description}</TooltipPopup>
    </Tooltip>
  );
}
