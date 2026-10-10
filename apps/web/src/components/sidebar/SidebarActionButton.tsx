import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function SidebarActionButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "relative inline-flex size-8 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-[background-color,scale] focus-visible:ring-2 motion-reduce:transition-none pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
        props["aria-disabled"]
          ? "cursor-not-allowed"
          : "cursor-pointer hover:bg-sidebar-row-hover active:scale-[0.97]",
        className,
      )}
      {...props}
    />
  );
}
