import { Dialog } from "@base-ui/react/dialog";
import { useStore } from "zustand";

import { APP_BASE_NAME } from "../../branding";
import { desktopUpdateRestart } from "../../state/desktopUpdateRestart";

export function DesktopUpdateRestartScreen() {
  const isRestarting = useStore(desktopUpdateRestart.store, (state) => state.isRestarting);

  return (
    <Dialog.Root open={isRestarting} onOpenChange={(_open, details) => details.cancel()}>
      <Dialog.Portal>
        <Dialog.Popup className="fixed inset-0 z-110 flex items-center justify-center bg-background p-6 text-foreground">
          <div className="flex max-w-xs flex-col gap-2 text-center">
            <Dialog.Title className="text-base font-medium">
              Restarting {APP_BASE_NAME}…
            </Dialog.Title>
            <Dialog.Description className="text-sm text-balance text-muted-foreground">
              Installing the update. The app will reopen automatically.
            </Dialog.Description>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
