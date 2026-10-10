import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import type { resolvePairingShareValue } from "./pairingUrls";
import type { RefObject } from "react";

export function PairingLinkCreatedDialog({
  result,
  onClose,
  finalFocus,
}: {
  readonly result: ReturnType<typeof resolvePairingShareValue> | null;
  readonly onClose: () => void;
  readonly finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "pairing link or code",
    onError: () =>
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: "Select and copy the value shown above.",
      }),
  });
  const isLink = result?.kind === "link";
  const copyLabel = isLink ? "Copy link" : "Copy code";

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{isLink ? "Pairing link created" : "Pairing code created"}</DialogTitle>
          <DialogDescription>
            {result?.qrShareable
              ? "Open this one-time link on your other device or scan the QR code."
              : "Use this one-time link or code to pair a client that can reach this host."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            aria-label={isLink ? "Pairing link" : "Pairing code"}
            readOnly
            value={result?.value ?? ""}
            rows={isLink ? 4 : 2}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
          {result?.qrShareable ? (
            <div className="flex justify-center">
              <div className="w-fit rounded-xl bg-white p-3">
                <QRCodeSvg
                  value={result.value}
                  size={192}
                  level="M"
                  marginSize={2}
                  title="Pairing link QR code"
                />
              </div>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
          <Button
            onClick={() => {
              if (result) copyToClipboard(result.value, undefined);
            }}
          >
            {isCopied ? "Copied" : copyLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
