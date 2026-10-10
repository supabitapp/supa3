import { MessageSquareTextIcon } from "lucide-react";
import { useSendFeedback } from "../../hooks/useSendFeedback";
import { SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarActionButton } from "./SidebarActionButton";

export function SidebarFeedbackButton() {
  const { sendFeedback, isPending, unavailableReason } = useSendFeedback();
  const { isMobile, setOpenMobile } = useSidebar();
  const label = isPending ? "Starting feedback…" : "Send feedback";
  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarActionButton
              aria-label={label}
              aria-busy={isPending || undefined}
              aria-disabled={isPending || unavailableReason !== null || undefined}
              onClick={() => {
                if (isPending || unavailableReason !== null) return;
                if (isMobile) setOpenMobile(false);
                void sendFeedback();
              }}
            >
              {isPending ? (
                <Spinner size="md" />
              ) : (
                <MessageSquareTextIcon aria-hidden="true" className="size-4" />
              )}
            </SidebarActionButton>
          }
        />
        <TooltipPopup align="center" side="top" variant="glass">
          {unavailableReason ?? label}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
