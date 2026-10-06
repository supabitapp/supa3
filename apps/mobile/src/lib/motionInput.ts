let keyboardMotionSuppressedUntil = 0;

/** Covers the local render following a native keyboard command without scheduling a timer. */
export function suppressKeyboardMotion() {
  keyboardMotionSuppressedUntil = Date.now() + 300;
}

export function isKeyboardMotionSuppressed() {
  return Date.now() < keyboardMotionSuppressedUntil;
}
