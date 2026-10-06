import { RelayManagedEndpointOrigin } from "@supacode/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as Allocations from "../environments/ManagedEndpointAllocations.ts";

const Allocation = Schema.Struct({
  userId: Schema.String,
  environmentId: Schema.String,
  hostname: Schema.String,
  tunnelId: Schema.NullOr(Schema.String),
  tunnelName: Schema.String,
  dnsRecordId: Schema.NullOr(Schema.String),
  readyAt: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(RelayManagedEndpointOrigin),
  updatedAt: Schema.String,
  generation: Schema.Int,
  tunnelReleasedAt: Schema.NullOr(Schema.String),
});
const allocationJson = Schema.fromJsonString(Allocation);
const decode = Schema.decodeUnknownEffect(allocationJson);
const encode = Schema.encodeEffect(allocationJson);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.orDie);
  yield* sql`PRAGMA busy_timeout = 5000`.pipe(Effect.orDie);
  yield* sql`CREATE TABLE IF NOT EXISTS connect_allocations (
    owner_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    tunnel_name TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    PRIMARY KEY (owner_id, environment_id)
  )`.pipe(Effect.orDie);

  const failure =
    (
      operation: Allocations.ManagedEndpointAllocationPersistenceError["operation"],
      input: { readonly userId: string; readonly environmentId: string },
    ) =>
    (cause: unknown) =>
      new Allocations.ManagedEndpointAllocationPersistenceError({
        operation,
        stage: "database-request",
        ...input,
        cause,
      });

  const read = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly environmentId: string;
  }) {
    const rows = yield* sql<{ payload: string }>`SELECT payload FROM connect_allocations
      WHERE owner_id = ${input.userId} AND environment_id = ${input.environmentId}`;
    return rows[0] === undefined ? null : yield* decode(rows[0].payload);
  });

  const update = Effect.fnUntraced(function* (
    input: { readonly userId: string; readonly environmentId: string },
    operation: Allocations.ManagedEndpointAllocationPersistenceError["operation"],
    change: (
      row: Allocations.ManagedEndpointAllocation,
      now: string,
    ) => Allocations.ManagedEndpointAllocation | null,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* read(input);
          if (row === null) return null;
          const next = change(row, DateTime.formatIso(yield* DateTime.now));
          if (next === null) return null;
          const payload = yield* encode(next);
          yield* sql`UPDATE connect_allocations SET payload = ${payload}
        WHERE owner_id = ${input.userId} AND environment_id = ${input.environmentId}`;
          return next;
        }),
      )
      .pipe(Effect.mapError(failure(operation, input)));
  });

  return Allocations.ManagedEndpointAllocations.of({
    get: (input) => read(input).pipe(Effect.mapError(failure("get", input))),
    getByTunnelName: (name) =>
      sql<{
        payload: string;
      }>`SELECT payload FROM connect_allocations WHERE tunnel_name = ${name}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decode(rows[0].payload),
        ),
        Effect.mapError(failure("get-by-tunnel-name", { userId: "local", environmentId: "local" })),
      ),
    reserve: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* read(input);
            if (existing !== null) {
              if (existing.hostname !== input.hostname || existing.tunnelName !== input.tunnelName)
                return yield* new Allocations.ManagedEndpointAllocationPersistenceError({
                  operation: "reserve",
                  stage: "resolve-reservation",
                  ...input,
                  cause: "Installation identity cannot change while an allocation exists.",
                });
              return existing;
            }
            const row = {
              ...input,
              tunnelId: null,
              dnsRecordId: null,
              readyAt: null,
              origin: null,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
              generation: 0,
              tunnelReleasedAt: null,
            };
            const payload = yield* encode(row);
            yield* sql`INSERT INTO connect_allocations (owner_id, environment_id, tunnel_name, payload)
        VALUES (${input.userId}, ${input.environmentId}, ${input.tunnelName}, ${payload})`;
            return row;
          }),
        )
        .pipe(Effect.mapError(failure("reserve", input))),
    recordTunnel: (input) =>
      update(input, "record-tunnel", (row, now) =>
        row.generation !== input.generation
          ? null
          : {
              ...row,
              tunnelId: input.tunnelId,
              generation: row.generation + 1,
              readyAt: row.tunnelId === input.tunnelId ? row.readyAt : null,
              origin: row.tunnelId === input.tunnelId ? row.origin : null,
              updatedAt: now,
              tunnelReleasedAt: null,
            },
      ).pipe(Effect.map((row) => row?.generation ?? null)),
    recordDns: (input) =>
      update(input, "record-dns", (row, now) =>
        row.generation !== input.generation || row.tunnelId !== input.tunnelId
          ? null
          : {
              ...row,
              dnsRecordId: input.dnsRecordId,
              generation: row.generation + 1,
              updatedAt: now,
            },
      ).pipe(Effect.map((row) => row?.generation ?? null)),
    markReady: (input) =>
      update(input, "mark-ready", (row, now) =>
        row.generation !== input.generation || row.tunnelId !== input.tunnelId
          ? null
          : {
              ...row,
              origin: input.origin,
              generation: row.generation + 1,
              readyAt: now,
              updatedAt: now,
            },
      ).pipe(Effect.map((row) => row !== null)),
    // Local recovery never enrolls the installation in the relay's recovery registry.
    enableRecovery: () => Effect.succeed(false),
    listByTunnelNames: (names) =>
      names.length === 0
        ? Effect.succeed([])
        : sql<{
            payload: string;
          }>`SELECT payload FROM connect_allocations WHERE tunnel_name IN ${sql.in(names)}`.pipe(
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                decode(row.payload).pipe(
                  Effect.map((allocation) => ({ ...allocation, recoveryEnabled: false })),
                ),
              ),
            ),
            Effect.mapError(failure("list-tunnels", { userId: "local", environmentId: "local" })),
          ),
    claimRelease: (input) =>
      update(input, "claim-release", (row, now) =>
        row.generation !== input.generation || row.tunnelId !== input.tunnelId
          ? null
          : {
              ...row,
              generation: row.generation + 1,
              tunnelId: null,
              readyAt: row.tunnelId === input.tunnelId ? row.readyAt : null,
              origin: row.tunnelId === input.tunnelId ? row.origin : null,
              updatedAt: now,
              tunnelReleasedAt: input.markReleased ? now : row.tunnelReleasedAt,
            },
      ).pipe(Effect.map((row) => row?.generation ?? null)),
    withClaimedTunnel: (input, operation) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Acquire SQLite's write lock before checking the generation or calling Cloudflare.
            // The dedicated allocation database keeps this lease off the orchestration database.
            yield* sql`UPDATE connect_allocations SET payload = payload
        WHERE owner_id = ${input.userId} AND environment_id = ${input.environmentId}`.pipe(
              Effect.mapError(failure("lock-tunnel", input)),
            );
            const row = yield* read(input).pipe(Effect.mapError(failure("lock-tunnel", input)));
            if (
              row === null ||
              row.generation !== input.generation ||
              row.tunnelId !== input.tunnelId
            )
              return Option.none();
            return Option.some(yield* operation);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            SqlError.isSqlError(cause) ? failure("lock-tunnel", input)(cause) : cause,
          ),
        ),
    claimDeprovision: (input) =>
      update(input, "claim-deprovision", (row, now) =>
        row.generation !== input.generation
          ? null
          : { ...row, generation: row.generation + 1, updatedAt: now },
      ).pipe(Effect.map((row) => row?.generation ?? null)),
    remove: (input) =>
      sql`DELETE FROM connect_allocations
      WHERE owner_id = ${input.userId} AND environment_id = ${input.environmentId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failure("remove", input)),
      ),
    removeClaimed: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* read(input);
            if (row === null || row.generation !== input.generation) return false;
            yield* sql`DELETE FROM connect_allocations
        WHERE owner_id = ${input.userId} AND environment_id = ${input.environmentId}`;
            return true;
          }),
        )
        .pipe(Effect.mapError(failure("remove-claimed", input))),
  });
});

export const layer = Layer.effect(Allocations.ManagedEndpointAllocations, make);
