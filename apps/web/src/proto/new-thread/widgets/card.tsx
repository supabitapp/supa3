import { Component, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { useWidgetEnv } from "./context";
import { titleOf, type WidgetDef } from "./registry";

const noSubscription = () => () => {};

export function useWidgetTitle(def: WidgetDef) {
  return useSyncExternalStore(def.titles?.subscribe ?? noSubscription, () => titleOf(def));
}

export function WidgetHeading(props: { def: WidgetDef; id?: string; actions?: ReactNode }) {
  const { data } = useWidgetEnv();
  const Icon = props.def.icon;
  const count = props.def.count?.(data);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/80" />
      <h2 id={props.id} className="truncate text-xs font-medium text-muted-foreground">
        {props.def.title}
      </h2>
      {count && count.n > 0 ? (
        <span
          className={cn(
            "rounded-sm px-1 text-2xs font-medium tabular-nums",
            count.urgent ? "bg-warning/15 text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {count.n}
        </span>
      ) : null}
      <span className="flex-1" />
      {props.actions}
    </div>
  );
}

export class WidgetBoundary extends Component<
  { title: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-sm font-medium text-foreground">{this.props.title} hit an error</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{this.state.error.message}</p>
        <Button
          size="xs"
          variant="outline"
          className="mt-1"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </Button>
      </div>
    );
  }
}
