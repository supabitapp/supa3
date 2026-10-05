import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  ThreadId,
  TurnItemId,
} from "@supacode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { threadKey } from "./entities.ts";

export type ThreadHistoryLoadEarlierResult =
  | { readonly _tag: "loaded" }
  | { readonly _tag: "noop" }
  | { readonly _tag: "busy" }
  | { readonly _tag: "error"; readonly message: string };

export type ThreadHistoryTarget = {
  readonly itemId: TurnItemId;
  readonly threadId: ThreadId;
};

export type ThreadHistoryLoadAroundResult =
  | { readonly _tag: "loaded"; readonly projection: OrchestrationV2ThreadProjection }
  | { readonly _tag: "noop" }
  | { readonly _tag: "busy" }
  | { readonly _tag: "error"; readonly message: string };

export type ThreadHistoryHandler = {
  readonly loadEarlier: () => Effect.Effect<ThreadHistoryLoadEarlierResult>;
  readonly loadAround: (
    target: ThreadHistoryTarget,
  ) => Effect.Effect<ThreadHistoryLoadAroundResult>;
};

/**
 * Opaque registration token returned by `register`. Finalizers must pass the
 * same token so an older fiber cannot delete a newer handler for the key.
 */
export type ThreadHistoryRegistration = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly handler: ThreadHistoryHandler;
};

/**
 * Per-thread registration for progressive history loads. Thread state fibers
 * register while active; mobile UI dispatches through `loadEarlier`.
 */
export class ThreadHistoryController extends Context.Service<
  ThreadHistoryController,
  {
    readonly register: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      handler: ThreadHistoryHandler,
    ) => Effect.Effect<ThreadHistoryRegistration>;
    readonly unregister: (registration: ThreadHistoryRegistration) => Effect.Effect<void>;
    readonly loadEarlier: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadHistoryLoadEarlierResult>;
    readonly loadAround: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      target: ThreadHistoryTarget,
    ) => Effect.Effect<ThreadHistoryLoadAroundResult>;
  }
>()("@supacode/client-runtime/state/threadHistoryController") {}

export const layer: Layer.Layer<ThreadHistoryController> = Layer.effect(
  ThreadHistoryController,
  Effect.gen(function* () {
    const handlers = yield* Ref.make(new Map<string, ThreadHistoryHandler>());
    return ThreadHistoryController.of({
      register: (environmentId, threadId, handler) =>
        Ref.update(handlers, (current) => {
          const next = new Map(current);
          next.set(threadKey({ environmentId, threadId }), handler);
          return next;
        }).pipe(
          Effect.as({
            environmentId,
            threadId,
            handler,
          } satisfies ThreadHistoryRegistration),
        ),
      unregister: (registration) =>
        Ref.update(handlers, (current) => {
          const key = threadKey({
            environmentId: registration.environmentId,
            threadId: registration.threadId,
          });
          // Only remove when this registration still owns the slot. An older
          // fiber finalizer must not delete a newer handler for the same key.
          if (current.get(key) !== registration.handler) {
            return current;
          }
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
      loadEarlier: (environmentId, threadId) =>
        Ref.get(handlers).pipe(
          Effect.flatMap((current) => {
            const handler = current.get(threadKey({ environmentId, threadId }));
            if (handler === undefined) {
              return Effect.succeed({ _tag: "noop" } satisfies ThreadHistoryLoadEarlierResult);
            }
            return handler.loadEarlier();
          }),
        ),
      loadAround: (environmentId, threadId, target) =>
        Ref.get(handlers).pipe(
          Effect.flatMap((current) => {
            const handler = current.get(threadKey({ environmentId, threadId }));
            return handler === undefined
              ? Effect.succeed({ _tag: "noop" } satisfies ThreadHistoryLoadAroundResult)
              : handler.loadAround(target);
          }),
        ),
    });
  }),
);
