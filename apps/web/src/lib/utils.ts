import { MessageId, ProjectId, ThreadId } from "@supacode/contracts";
import { isMacPlatform } from "@supacode/shared/keybindings";
import { type CxOptions, cx } from "class-variance-authority";
import { randomUUID } from "./randomUUID";
import { extendTailwindMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";

// The theme's extra font sizes (index.css). Unregistered, tailwind-merge reads
// text-2xs as a colour and drops it next to text-muted-foreground.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs", "4xs", "5xs"] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export { isMacPlatform };

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "File Explorer";
  }
  return "Files";
}

export { randomUUID } from "./randomUUID";

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());
