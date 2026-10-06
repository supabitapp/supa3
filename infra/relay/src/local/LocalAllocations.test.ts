import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Sqlite from "@supacode/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Allocations from "../environments/ManagedEndpointAllocations.ts";
import * as Local from "./LocalAllocations.ts";

const key = { userId: "owner", environmentId: "environment" };
const layer = Local.layer.pipe(
  Layer.provide(Sqlite.layer({ filename: ":memory:" })),
  Layer.provide(NodeServices.layer),
);
it.effect("serializes external work against allocation claims and refuses stale generations", () =>
  Effect.gen(function* () {
    const allocations = yield* Allocations.ManagedEndpointAllocations;
    const row = yield* allocations.reserve({
      ...key,
      hostname: "host.example.test",
      tunnelName: "owned-tunnel",
    });
    const generation = yield* allocations.recordTunnel({
      ...key,
      tunnelId: "tunnel",
      generation: row.generation,
    });
    expect(generation).not.toBeNull();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const changed = yield* Deferred.make<void>();
    const owner = yield* allocations
      .withClaimedTunnel(
        { ...key, tunnelId: "tunnel", generation: generation! },
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("completed"),
        ),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const contender = yield* allocations.claimDeprovision({ ...key, generation: generation! }).pipe(
      Effect.tap(() => Deferred.succeed(changed, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    expect(yield* Deferred.isDone(changed)).toBe(false);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(owner)).toEqual(Option.some("completed"));
    const currentGeneration = yield* Fiber.join(contender);
    expect(currentGeneration).toBe(generation! + 1);
    expect(
      yield* allocations.withClaimedTunnel(
        { ...key, tunnelId: "tunnel", generation: generation! },
        Effect.die("Stale work must not run."),
      ),
    ).toEqual(Option.none());
    expect(yield* allocations.removeClaimed({ ...key, generation: generation! })).toBe(false);
    expect(yield* allocations.get(key)).not.toBeNull();
    expect(yield* allocations.removeClaimed({ ...key, generation: currentGeneration! })).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves readiness for the same tunnel and clears it for a replacement", () =>
  Effect.gen(function* () {
    const allocations = yield* Allocations.ManagedEndpointAllocations;
    yield* allocations.reserve({
      ...key,
      hostname: "host.example.test",
      tunnelName: "owned-tunnel",
    });
    const generation = yield* allocations.recordTunnel({
      ...key,
      tunnelId: "tunnel",
      generation: 0,
    });
    yield* allocations.markReady({
      ...key,
      tunnelId: "tunnel",
      generation: generation!,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 12345 },
    });
    const ready = (yield* allocations.get(key))!;
    expect(ready.generation).toBe(generation! + 1);
    const same = yield* allocations.recordTunnel({
      ...key,
      tunnelId: "tunnel",
      generation: ready.generation,
    });
    expect((yield* allocations.get(key))?.readyAt).toBe(ready.readyAt);
    yield* allocations.recordTunnel({ ...key, tunnelId: "replacement", generation: same! });
    expect(yield* allocations.get(key)).toMatchObject({ readyAt: null, origin: null });
  }).pipe(Effect.provide(layer)),
);
