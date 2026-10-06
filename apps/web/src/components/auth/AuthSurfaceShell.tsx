import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { resolveSidebarStageBackdropVariant, StageBackdropArt } from "../SidebarStageBackdrop";
import { StandalonePage } from "../ui/standalone-page";

/**
 * Branded masthead for the CLI-connect authorize and callback pages.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageVariant = resolveSidebarStageBackdropVariant(APP_STAGE_LABEL);

  return (
    <StandalonePage tone="pairing">
      <header className="relative h-24 overflow-hidden bg-linear-to-br from-primary to-primary/80 text-primary-foreground">
        {stageVariant ? (
          <div className="absolute inset-0" aria-hidden>
            <StageBackdropArt variant={stageVariant} />
          </div>
        ) : null}
        <div className="absolute inset-0 bg-linear-to-b from-transparent to-background/40" />
        <div className="relative h-full p-5 sm:p-6">
          <p className="text-3xs font-semibold tracking-widest text-primary-foreground/80 uppercase">
            {APP_DISPLAY_NAME}
          </p>
        </div>
      </header>
      {children}
    </StandalonePage>
  );
}
