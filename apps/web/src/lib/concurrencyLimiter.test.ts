import { expect, it } from "vite-plus/test";
import { createConcurrencyLimiter } from "./concurrencyLimiter";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("bounds active byte operations and releases capacity after a rejected operation", async () => {
  const limit = createConcurrencyLimiter(2);
  const firstGate = deferred();
  const secondGate = deferred();
  const thirdStarted = deferred();
  let active = 0;
  let peak = 0;
  const enter = () => {
    active += 1;
    peak = Math.max(peak, active);
  };
  const first = limit(async () => {
    enter();
    await firstGate.promise;
    active -= 1;
  });
  const failure = new Error("Interrupted download");
  const second = limit(async () => {
    enter();
    await secondGate.promise;
    active -= 1;
    throw failure;
  });
  const rejected = expect(second).rejects.toBe(failure);
  const third = limit(async () => {
    enter();
    thirdStarted.resolve();
    active -= 1;
  });
  expect(active).toBe(2);
  secondGate.resolve();
  await thirdStarted.promise;
  firstGate.resolve();
  await Promise.all([first, third, rejected]);
  await limit(async () => {
    enter();
    active -= 1;
  });
  expect(peak).toBe(2);
  expect(active).toBe(0);
});
