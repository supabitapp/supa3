import "./proto.css";

import type { EnvironmentProject } from "@supacode/client-runtime/state/shell";
import {
  Component,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { ComposerHandleRef } from "../../composerHandleContext";
import { Desk } from "./Desk";
import { Harbor } from "./Harbor";
import { Launchpad } from "./Launchpad";
import { Pulse } from "./Pulse";
import { Widgets } from "./Widgets";
import { useProtoData, type ProtoData } from "./data";

type VariantProps = { data: ProtoData; composerRef: ComposerHandleRef };

const VARIANTS: ReadonlyArray<{
  name: string;
  component: ComponentType<VariantProps> | null;
  fade?: boolean;
}> = [
  { name: "Current", component: null },
  { name: "Desk", component: Desk },
  { name: "Launchpad", component: Launchpad },
  { name: "Harbor", component: Harbor },
  { name: "Pulse", component: Pulse },
  { name: "Widgets", component: Widgets, fade: true },
];

const VARIANT_KEY = "supacode:proto:new-thread:v";
const DATA_KEY = "supacode:proto:new-thread:data";
const DOCK_COMPOSER_CSS = `[data-chat-composer-overlay="true"]{align-items:flex-end !important}`;

function readInitialVariant() {
  const fromUrl = Number.parseInt(new URLSearchParams(window.location.search).get("v") ?? "", 10);
  const fromStorage = Number.parseInt(window.localStorage.getItem(VARIANT_KEY) ?? "", 10);
  const value = Number.isNaN(fromUrl) ? fromStorage : fromUrl;
  return value >= 1 && value <= VARIANTS.length ? value - 1 : 0;
}

function useComposerClearance(layer: HTMLElement | null) {
  const [clearance, setClearance] = useState(240);
  useLayoutEffect(() => {
    const canvas = layer?.closest("[data-chat-canvas]") ?? document;
    const overlay = canvas.querySelector<HTMLElement>('[data-chat-composer-overlay="true"]');
    const stack = overlay?.querySelector<HTMLElement>('[data-chat-composer-stack="true"]');
    const host = layer?.parentElement;
    if (!host || !overlay || !stack) return;
    const measure = () => {
      const stackTop = stack.getBoundingClientRect().top;
      const hostBottom = host.getBoundingClientRect().bottom;
      setClearance(Math.max(0, hostBottom - stackTop) + 12);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stack);
    observer.observe(host);
    return () => observer.disconnect();
  }, [layer]);
  return clearance;
}

const ENABLED_KEY = "supacode:proto:new-thread:enabled";

function readEnabled() {
  const flag = new URLSearchParams(window.location.search).get("proto");
  if (flag === "1") window.localStorage.setItem(ENABLED_KEY, "1");
  if (flag === "0") window.localStorage.removeItem(ENABLED_KEY);
  return window.localStorage.getItem(ENABLED_KEY) === "1";
}

type HarnessProps = { project: EnvironmentProject | null; composerRef: ComposerHandleRef };

export default function NewThreadHeroProto(props: HarnessProps) {
  const [enabled] = useState(readEnabled);
  if (!enabled) return null;
  return (
    <VariantBoundary name="Prototype harness">
      <Harness {...props} />
    </VariantBoundary>
  );
}

function Harness(props: HarnessProps) {
  const [index, setIndex] = useState(readInitialVariant);
  const [mountKey, setMountKey] = useState(0);
  const [busy, setBusy] = useState(() => window.localStorage.getItem(DATA_KEY) === "busy");
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const data = useProtoData(props.project, busy);
  const clearance = useComposerClearance(layer);

  const select = (next: number) => {
    if (next < 0 || next >= VARIANTS.length) return;
    setIndex(next);
    setMountKey((key) => key + 1);
    window.localStorage.setItem(VARIANT_KEY, String(next + 1));
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(next + 1));
    window.history.replaceState(window.history.state, "", url);
  };
  const replay = () => setMountKey((key) => key + 1);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && target !== document.body && !target.closest("[data-proto-picker]")) return;
    const count = VARIANTS.length;
    const num = Number.parseInt(event.key, 10);
    if (num >= 1 && num <= count) select(num - 1);
    else if (event.key === "ArrowRight") select((index + 1) % count);
    else if (event.key === "ArrowLeft") select((index - 1 + count) % count);
    else if (event.key === "r" || event.key === "R") replay();
    else return;
    event.preventDefault();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const Variant = VARIANTS[index]?.component ?? null;

  return (
    <>
      {Variant ? (
        <>
          <style>{DOCK_COMPOSER_CSS}</style>
          <div
            ref={setLayer}
            data-proto-layer
            className="absolute inset-x-0 top-0 z-10 overflow-y-auto"
            data-proto-fade-bottom={VARIANTS[index]?.fade ? "" : undefined}
            style={{ bottom: clearance }}
          >
            <VariantBoundary key={`${index}:${mountKey}`} name={VARIANTS[index]?.name ?? ""}>
              <Variant data={data} composerRef={props.composerRef} />
            </VariantBoundary>
          </div>
        </>
      ) : null}
      {createPortal(
        <>
          <Picker
            names={VARIANTS.map((v) => v.name)}
            index={index}
            onSelect={select}
            onReplay={replay}
          />
          <div data-proto-panel="" role="group" aria-label="Prototype data">
            <span data-proto-panel-label="">Data</span>
            {(["live", "busy"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-proto-picker-item=""
                data-active={(mode === "busy") === busy ? "" : undefined}
                aria-pressed={(mode === "busy") === busy}
                onClick={() => {
                  setBusy(mode === "busy");
                  window.localStorage.setItem(DATA_KEY, mode);
                }}
              >
                {mode === "live" ? "Live" : "Busy day"}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

class VariantBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <p className="p-6 text-center font-mono text-xs text-error">
        {this.props.name} crashed: {this.state.error.message}
      </p>
    );
  }
}

function Picker(props: {
  names: ReadonlyArray<string>;
  index: number;
  onSelect: (index: number) => void;
  onReplay: () => void;
}) {
  const highlightRef = useRef<HTMLSpanElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const move = () => {
      const item = itemRefs.current[props.index];
      const highlight = highlightRef.current;
      if (!item || !highlight) return;
      highlight.style.width = `${item.offsetWidth}px`;
      highlight.style.transform = `translateX(${item.offsetLeft}px)`;
    };
    move();
    window.addEventListener("resize", move);
    return () => window.removeEventListener("resize", move);
  }, [props.index]);

  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  return (
    <nav
      data-proto-picker=""
      data-position="top"
      data-ready={ready ? "" : undefined}
      aria-label="Prototype variants"
    >
      <span ref={highlightRef} data-proto-picker-highlight="" aria-hidden="true" />
      {props.names.map((name, i) => (
        <button
          key={name}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          data-proto-picker-item=""
          data-active={i === props.index ? "" : undefined}
          aria-current={i === props.index ? "true" : undefined}
          onClick={() => props.onSelect(i)}
        >
          {name}
        </button>
      ))}
      <span data-proto-picker-divider="" aria-hidden="true" />
      <button
        type="button"
        data-proto-picker-item=""
        data-proto-picker-replay=""
        aria-label="Replay animation (R)"
        onClick={props.onReplay}
      >
        ↻
      </button>
    </nav>
  );
}
