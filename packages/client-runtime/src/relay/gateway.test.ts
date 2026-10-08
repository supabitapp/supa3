import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { relayHttpBaseUrl, relayPublicKey } from "@supacode/shared/relay/protocol";
import { layer, RelayGateway } from "./gateway.ts";

const address = relayHttpBaseUrl(relayPublicKey(new Uint8Array(32).fill(19)));
it.effect("reuses one endpoint, refreshes preparation and closes on runtime disposal", () =>
  Effect.gen(function* () {
    let opens = 0;
    let closes = 0;
    let port = 1000;
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response("okay");
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* RelayGateway;
        const values = yield* Effect.promise(() =>
          Promise.all([gateway.resolve(address), gateway.resolve(address)]),
        );
        expect(values).toEqual(["http://127.0.0.1:1000", "http://127.0.0.1:1000"]);
        expect(opens).toBe(1);
        port = 2000;
        expect(yield* Effect.promise(() => gateway.resolve(address))).toBe("http://127.0.0.1:2000");
        yield* Effect.promise(() => gateway.fetch(address + "api/test?range=2"));
        expect(requests).toEqual(["http://127.0.0.1:2000/api/test?range=2"]);
      }).pipe(
        Effect.provide(
          layer({
            fetch: fetcher,
            open: async () => {
              opens++;
              return {
                prepare: async () => `http://127.0.0.1:${port}`,
                close: async () => {
                  closes++;
                },
              };
            },
          }),
        ),
      ),
    );
    expect(closes).toBe(1);
  }),
);

it.effect("waits for an old endpoint to close before opening its replacement", () =>
  Effect.gen(function* () {
    let closeStarted!: () => void;
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    let opens = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* RelayGateway;
        yield* Effect.promise(() => gateway.resolve(address));
        const released = gateway.release(address);
        yield* Effect.promise(() => closing);
        const prepared = gateway.resolve(address);
        expect(opens).toBe(1);
        finishClose();
        yield* Effect.promise(() => released);
        expect(yield* Effect.promise(() => prepared)).toBe("http://127.0.0.1:1002");
      }).pipe(
        Effect.provide(
          layer({
            fetch,
            open: async () => {
              const generation = ++opens;
              return {
                prepare: async () => `http://127.0.0.1:${1000 + generation}`,
                close: async () => {
                  if (generation === 1) {
                    closeStarted();
                    await closed;
                  }
                },
              };
            },
          }),
        ),
      ),
    );
  }),
);

it.effect("reopens after an endpoint fails to close", () => {
  let opens = 0;
  return Effect.gen(function* () {
    const gateway = yield* RelayGateway;
    yield* Effect.promise(() => gateway.resolve(address));
    yield* Effect.promise(() => gateway.release(address));
    expect(yield* Effect.promise(() => gateway.resolve(address))).toBe("http://127.0.0.1:1002");
  }).pipe(
    Effect.provide(
      layer({
        fetch,
        open: async () => {
          const generation = ++opens;
          return {
            prepare: async () => `http://127.0.0.1:${1000 + generation}`,
            close: async () => {
              throw new Error("Companion offline");
            },
          };
        },
      }),
    ),
  );
});
