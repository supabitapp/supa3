import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const motion = vi.hoisted(() => ({
  reduced: false,
  keyboard: false,
  finishes: [] as Array<() => void>,
}));
vi.mock("react-native", () => ({ View: "view" }));
vi.mock("../lib/useReducedMotionPreference", () => ({
  useReducedMotionPreference: () => motion.reduced,
}));
vi.mock("../lib/motionInput", () => ({ isKeyboardMotionSuppressed: () => motion.keyboard }));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    default: { View: "layer" },
    Easing: { bezier: () => undefined },
    ReduceMotion: { Never: "never" },
    runOnJS: (fn: (key?: string) => void) => fn,
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useSharedValue: (initial: number) =>
      useRef({ value: initial, set: (_value: unknown) => undefined }).current,
    withTiming: (_target: number, _options: unknown, finish?: (finished: boolean) => void) => {
      if (finish) motion.finishes.push(() => finish(true));
      return 0;
    },
  };
});

import { MotionSwap } from "./MotionSwap";
import { MotionPresence } from "./MotionPresence";

let renderer: ReactTestRenderer | undefined;
const text = () => renderer!.root.findAllByType("label").map((node) => node.children.join(""));
async function render(key: string, value: string) {
  await act(async () => {
    const element = (
      <MotionSwap stateKey={key}>
        <label>{value}</label>
      </MotionSwap>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
async function finish() {
  const callbacks = motion.finishes.splice(0);
  await act(async () => {
    for (const callback of callbacks) callback();
  });
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  motion.finishes = [];
  motion.reduced = false;
  motion.keyboard = false;
});

describe("discrete state motion", () => {
  it("renders a retiring request as inactive while its replacement is active", async () => {
    await act(async () => {
      renderer = create(
        <MotionSwap stateKey="first">
          {(active) => <label>{active ? "Answer first" : "First disabled"}</label>}
        </MotionSwap>,
      );
    });
    await act(async () => {
      renderer!.update(
        <MotionSwap stateKey="second">
          {(active) => <label>{active ? "Answer second" : "Second disabled"}</label>}
        </MotionSwap>,
      );
    });
    expect(text()).toEqual(["First disabled", "Answer second"]);
    await finish();
    expect(text()).toEqual(["Answer second"]);
  });
  it("keeps live same-state text immediate and retires its latest content when the state changes", async () => {
    await render("working", "Reading files");
    await render("working", "Running tests");
    expect(text()).toEqual(["Running tests"]);
    await render("completed", "Done");
    expect(text()).toEqual(["Running tests", "Done"]);
    await finish();
    expect(text()).toEqual(["Done"]);
  });

  it("keeps a restored state when an interrupted departure completes late", async () => {
    await render("uploading", "Uploading");
    await render("failed", "Retry");
    await render("uploading", "Uploading again");
    expect(text()).toEqual(["Retry", "Uploading again"]);
    await finish();
    expect(text()).toEqual(["Uploading again"]);
  });

  it.each(["reduced", "keyboard"] as const)(
    "swaps immediately under %s suppression",
    async (preference) => {
      await render("pending", "Pending");
      motion[preference] = true;
      await render("acknowledged", "Sent");
      expect(text()).toEqual(["Sent"]);
    },
  );

  it("drops outgoing content when reduced motion changes during a swap", async () => {
    await render("running", "Running");
    await render("failed", "Failed");
    motion.reduced = true;
    await render("failed", "Failed");
    expect(text()).toEqual(["Failed"]);
    await finish();
    expect(text()).toEqual(["Failed"]);
  });
});

describe("closing presence", () => {
  async function presence(visible: boolean, value: string | null) {
    await act(async () => {
      const element = (
        <MotionPresence visible={visible}>
          {value === null ? null : <label>{value}</label>}
        </MotionPresence>
      );
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  }

  it("keeps the last visible children when a conditional becomes empty", async () => {
    await presence(true, "2 queued");
    await presence(false, null);
    expect(text()).toEqual(["2 queued"]);
    await finish();
    expect(text()).toEqual([]);
  });

  it("does not remove content reopened before its departure completes", async () => {
    await presence(true, "Recovery");
    await presence(false, null);
    await presence(true, "Recovery again");
    await finish();
    expect(text()).toEqual(["Recovery again"]);
  });
});
