import { EASE_IN } from "~/lib/motion";

export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "supacode-draft-hero-transition";
export const MOBILE_COMPOSER_VIEW_TRANSITION_NAME = "supacode-mobile-composer";
export const MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME = "supacode-mobile-draft-headline";
const MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY = "--mobile-composer-transition-duration";

type ComposerViewTransition = {
  readonly finished: Promise<void>;
};

let activeMobileComposerTransition: Promise<void> | null = null;

type ComposerViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ComposerViewTransition;
};

export async function waitForDraftHeroTransition(): Promise<void> {
  const mobileComposerTransition = activeMobileComposerTransition;
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") {
    await mobileComposerTransition;
    return;
  }

  const activeTransitions = document
    .getAnimations()
    .filter((animation) => animation.id === DRAFT_HERO_TRANSITION_ANIMATION_ID);

  await Promise.all([
    mobileComposerTransition,
    ...activeTransitions.map(async (animation) => {
      try {
        await animation.finished;
      } catch {
        // A cancelled transition is already safe to hand off.
      }
    }),
  ]);
}

export async function runMobileComposerTransition(
  update: () => void | Promise<void>,
  options: { active: boolean; durationMs: number },
): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    await update();
    return;
  }

  const transitionDocument = document as ComposerViewTransitionDocument;
  const mobileViewport = window.matchMedia?.("(max-width: 639px)").matches ?? false;
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (
    !options.active ||
    !mobileViewport ||
    prefersReducedMotion ||
    !transitionDocument.startViewTransition
  ) {
    await update();
    return;
  }

  let updateStarted = false;
  const runUpdate = async () => {
    if (updateStarted) return;
    updateStarted = true;
    await update();
  };
  let transitionFinished: Promise<void> | null = null;
  transitionDocument.documentElement.style.setProperty(
    MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY,
    `${String(options.durationMs)}ms`,
  );
  transitionDocument.documentElement.dataset.mobileComposerRouteTransition = "true";
  try {
    const transition = transitionDocument.startViewTransition(runUpdate);
    transitionFinished = transition.finished.catch(() => undefined);
    activeMobileComposerTransition = transitionFinished;
    try {
      await transition.finished;
    } catch {
      await runUpdate();
    }
  } catch {
    await runUpdate();
  } finally {
    if (activeMobileComposerTransition === transitionFinished) {
      activeMobileComposerTransition = null;
    }
    delete transitionDocument.documentElement.dataset.mobileComposerRouteTransition;
    transitionDocument.documentElement.style.removeProperty(
      MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY,
    );
  }
}

/**
 * Copies the hero headline while it is still laid out, with the text styles it
 * inherits, so playDraftHeadlineExit can fade it after React removes the original.
 */
export function captureDraftHeadline(headline: HTMLElement): HTMLElement {
  const rect = headline.getBoundingClientRect();
  const inherited = getComputedStyle(headline);
  const ghost = headline.cloneNode(true) as HTMLElement;
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  for (const trigger of ghost.querySelectorAll("[data-draft-project-trigger]")) {
    trigger.removeAttribute("data-draft-project-trigger");
  }
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;margin:0;pointer-events:none;z-index:20`;
  Object.assign(ghost.style, {
    color: inherited.color,
    fontFamily: inherited.fontFamily,
    fontSize: inherited.fontSize,
    fontWeight: inherited.fontWeight,
    letterSpacing: inherited.letterSpacing,
    lineHeight: inherited.lineHeight,
    textAlign: inherited.textAlign,
  });
  return ghost;
}

/**
 * Fades a captured headline up and out where it stood while the composer docks:
 * the desktop twin of the mobile view transition's headline exit in index.css,
 * at the same speed relative to the composer move.
 */
export function playDraftHeadlineExit(
  ghost: HTMLElement,
  composerDurationMs: number,
): Promise<void> {
  document.body.append(ghost);
  const animation = ghost.animate(
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(-6px)" },
    ],
    { duration: composerDurationMs * 0.75, easing: EASE_IN, fill: "forwards" },
  );
  return animation.finished.catch(() => undefined).then(() => ghost.remove());
}
