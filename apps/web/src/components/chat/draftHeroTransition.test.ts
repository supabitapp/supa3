// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  captureDraftHeadline,
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  playDraftHeadlineExit,
  runMobileComposerTransition,
  waitForDraftHeroTransition,
} from "./draftHeroTransition";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("waitForDraftHeroTransition", () => {
  it("waits for active draft hero animations and ignores unrelated animations", async () => {
    let finishTransition: (() => void) | undefined;
    const transitionFinished = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    vi.stubGlobal("document", {
      getAnimations: () => [
        { id: "unrelated-animation", finished: new Promise<void>(() => undefined) },
        { id: DRAFT_HERO_TRANSITION_ANIMATION_ID, finished: transitionFinished },
      ],
    });

    let handoffComplete = false;
    const handoff = waitForDraftHeroTransition().then(() => {
      handoffComplete = true;
    });
    await Promise.resolve();
    expect(handoffComplete).toBe(false);

    finishTransition?.();
    await handoff;
    expect(handoffComplete).toBe(true);
  });

  it("allows the handoff when an active transition is cancelled", async () => {
    vi.stubGlobal("document", {
      getAnimations: () => [
        {
          id: DRAFT_HERO_TRANSITION_ANIMATION_ID,
          finished: Promise.reject(new Error("cancelled")),
        },
      ],
    });

    await expect(waitForDraftHeroTransition()).resolves.toBeUndefined();
  });
});

describe("runMobileComposerTransition", () => {
  it("keeps the route handoff waiting while the mobile composer morph is active", async () => {
    let finishTransition: (() => void) | undefined;
    const transitionFinished = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    const dataset: Record<string, string> = {};
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    vi.stubGlobal("document", {
      documentElement: { dataset, style },
      getAnimations: () => [],
      startViewTransition: (update: () => void | Promise<void>) => {
        void update();
        return { finished: transitionFinished };
      },
    });
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query === "(max-width: 639px)" }),
    });

    const transition = runMobileComposerTransition(() => undefined, {
      active: true,
      durationMs: 240,
    });
    await Promise.resolve();

    let handoffComplete = false;
    const handoff = waitForDraftHeroTransition().then(() => {
      handoffComplete = true;
    });
    await Promise.resolve();
    expect(handoffComplete).toBe(false);

    finishTransition?.();
    await Promise.all([transition, handoff]);
    expect(handoffComplete).toBe(true);
  });

  it("uses a scoped view transition on mobile", async () => {
    const dataset: Record<string, string> = {};
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => ({
      finished: Promise.resolve(update()).then(() => undefined),
    }));
    vi.stubGlobal("document", {
      documentElement: { dataset, style },
      startViewTransition,
    });
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query === "(max-width: 639px)" }),
    });
    const update = vi.fn();

    await runMobileComposerTransition(update, { active: true, durationMs: 360 });

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(style.setProperty).toHaveBeenCalledWith(
      "--mobile-composer-transition-duration",
      "360ms",
    );
    expect(style.removeProperty).toHaveBeenCalledWith("--mobile-composer-transition-duration");
    expect(dataset).not.toHaveProperty("mobileComposerRouteTransition");
  });

  it("updates without a view transition when panel animations are inactive", async () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      startViewTransition,
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    const update = vi.fn();

    await runMobileComposerTransition(update, { active: false, durationMs: 360 });

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it("updates without a view transition when reduced motion is preferred", async () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      startViewTransition,
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    const update = vi.fn();

    await runMobileComposerTransition(update, { active: true, durationMs: 360 });

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});

describe("playDraftHeadlineExit", () => {
  it("fades an inert copy styled as the headline was, after the original is removed", async () => {
    let finishFade: (() => void) | undefined;
    const animate = vi.fn(
      () =>
        ({
          finished: new Promise<void>((resolve) => {
            finishFade = resolve;
          }),
        }) as unknown as Animation,
    );
    HTMLElement.prototype.animate = animate;
    const headline = document.createElement("div");
    headline.style.fontSize = "30px";
    headline.innerHTML =
      '<h1>What should we build in <button data-draft-project-trigger="">app</button>?</h1>';
    document.body.append(headline);

    const ghost = captureDraftHeadline(headline);
    headline.remove();
    const removed = playDraftHeadlineExit(ghost, 400);

    expect(document.body.lastElementChild).toBe(ghost);
    expect(ghost.textContent).toBe("What should we build in app?");
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.style.fontSize).toBe("30px");
    expect(document.querySelector("[data-draft-project-trigger]")).toBeNull();
    expect(animate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ duration: 300 }),
    );

    finishFade?.();
    await removed;
    expect(ghost.isConnected).toBe(false);
  });
});
