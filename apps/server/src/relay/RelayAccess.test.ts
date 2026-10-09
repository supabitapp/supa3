import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type RelayAdvertisement,
  type RelayHostStatus,
} from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";
import { RelayIdentity } from "./RelayIdentity.ts";
import { RelayIngress } from "./RelayIngress.ts";
import * as RelayAccess from "./RelayAccess.ts";
import * as ServerSettings from "../serverSettings.ts";

const { startRelayTransport } = vi.hoisted(() => ({
  startRelayTransport: vi.fn<typeof import("./transport.ts").startRelayTransport>(),
}));
vi.mock("./transport.ts", () => ({ startRelayTransport }));

it.effect(
  "advertises configuration changes once and stops old transports before withdrawal or move",
  () =>
    Effect.gen(function* () {
      const address = `https://${"11".repeat(16)}.${"22".repeat(16)}.relay.supacode.invalid/`;
      const settings = yield* SubscriptionRef.make({
        ...DEFAULT_SERVER_SETTINGS,
        publicRelayEnabled: false,
      });
      const service = yield* ServerSettings.ServerSettingsService;
      const access = yield* RelayAccess.RelayAccess.pipe(
        Effect.provide(RelayAccess.layer),
        Effect.provideService(RelayIdentity, {
          get: Effect.succeed({ secret: new Uint8Array(32), address }),
        }),
        Effect.provideService(RelayIngress, { accept: () => {} }),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...service,
          getSettings: SubscriptionRef.get(settings),
          subscribeChanges: Effect.succeed(SubscriptionRef.changes(settings)),
        }),
      );
      const lifecycle: string[] = [];
      startRelayTransport.mockReset();
      startRelayTransport.mockImplementation(({ relayUrl }) => {
        lifecycle.push(`start:${relayUrl}`);
        return () => {
          lifecycle.push(`stop:${relayUrl}`);
        };
      });
      const advertisements = yield* Queue.unbounded<RelayAdvertisement | null>();
      const statuses = yield* Queue.unbounded<RelayHostStatus>();
      yield* access.advertisements.pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            lifecycle.push(`advertise:${value?.relayUrl ?? "off"}`);
          }).pipe(Effect.andThen(Queue.offer(advertisements, value))),
        ),
        Effect.forkChild,
      );
      yield* access.status.pipe(
        Stream.runForEach((value) => Queue.offer(statuses, value)),
        Effect.forkChild,
      );
      expect(yield* Queue.take(advertisements)).toBeNull();
      yield* access.start;
      yield* SubscriptionRef.update(settings, (value) => ({
        ...value,
        publicRelayEnabled: true,
        publicRelayUrl: "wss://first.example.test",
      }));
      expect(yield* Queue.take(advertisements)).toEqual({
        relayEndpoint: address,
        relayUrl: "wss://first.example.test",
      });
      const report = startRelayTransport.mock.calls[0]![0].onStatus;
      for (const state of ["registered", "superseded"] as const) {
        report?.(state);
        yield* Stream.fromQueue(statuses).pipe(
          Stream.filter((value) => value.state === state),
          Stream.runHead,
        );
      }
      yield* SubscriptionRef.update(settings, (value) => ({
        ...value,
        publicRelayUrl: "wss://second.example.test",
      }));
      expect(yield* Queue.take(advertisements)).toEqual({
        relayEndpoint: address,
        relayUrl: "wss://second.example.test",
      });
      yield* SubscriptionRef.update(settings, (value) => ({ ...value, publicRelayEnabled: false }));
      expect(yield* Queue.take(advertisements)).toBeNull();
      expect(lifecycle).toEqual([
        "advertise:off",
        "start:wss://first.example.test",
        "advertise:wss://first.example.test",
        "stop:wss://first.example.test",
        "start:wss://second.example.test",
        "advertise:wss://second.example.test",
        "stop:wss://second.example.test",
        "advertise:off",
      ]);
      expect(yield* access.advertisement).toEqual({});
    }).pipe(Effect.provide(ServerSettings.layerTest()), Effect.scoped),
);
