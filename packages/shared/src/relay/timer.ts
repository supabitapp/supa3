import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

export function after(milliseconds: number, callback: () => void) {
  const fiber = Effect.runFork(
    Effect.sleep(milliseconds).pipe(Effect.andThen(Effect.sync(callback))),
  );
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}
export function every(milliseconds: number, callback: () => void) {
  const fiber = Effect.runFork(
    Effect.forever(Effect.sleep(milliseconds).pipe(Effect.andThen(Effect.sync(callback)))),
  );
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}
