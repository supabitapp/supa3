// @effect-diagnostics globalTimers:off - callback-based sockets own and cancel these timers.
export function after(milliseconds: number, callback: () => void) {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
}

export function every(milliseconds: number, callback: () => void) {
  const timer = setInterval(callback, milliseconds);
  return () => clearInterval(timer);
}
