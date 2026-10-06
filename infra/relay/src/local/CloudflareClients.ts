import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import {
  managedEndpointDigestInput,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Allocations from "../environments/ManagedEndpointAllocations.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";

export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    status: Schema.Int,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return this.status === 401 || this.status === 403
      ? "Cloudflare authorization is missing or lacks tunnel/DNS permissions."
      : "The Cloudflare management request failed.";
  }
}

export class CloudflareResourceConflict extends Schema.TaggedError<CloudflareResourceConflict>()(
  "CloudflareResourceConflict",
  { resource: Schema.Literals(["tunnel", "dns", "account"]) },
) {
  override get message(): string {
    return "A Cloudflare resource belongs to another installation.";
  }
}

export class CloudflareApi extends Context.Service<
  CloudflareApi,
  {
    readonly request: <A>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      schema: Schema.Decoder<A, never>,
      body?: unknown,
    ) => Effect.Effect<A, CloudflareApiError>;
  }
>()("@supacode/relay/local/CloudflareClients/CloudflareApi") {}

const Envelope = Schema.Struct({ success: Schema.Boolean, result: Schema.Unknown });

export const layerApi = (token: Redacted.Redacted<string>) =>
  Layer.effect(
    CloudflareApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request: CloudflareApi["Service"]["request"] = (method, path, schema, body) =>
        Effect.gen(function* () {
          const operation = `${method} ${path.split("?")[0]}`;
          let req = HttpClientRequest.make(method)(
            `https://api.cloudflare.com/client/v4${path}`,
          ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`));
          if (body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, body);
          const response = yield* client.execute(req).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(() => new CloudflareApiError({ status: 0, operation })),
          );
          if (response.status < 200 || response.status >= 300)
            return yield* new CloudflareApiError({ status: response.status, operation });
          const envelope = yield* HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
            Effect.mapError(() => new CloudflareApiError({ status: response.status, operation })),
          );
          if (!envelope.success)
            return yield* new CloudflareApiError({ status: response.status, operation });
          return yield* Schema.decodeUnknownEffect(schema)(envelope.result).pipe(
            Effect.mapError(() => new CloudflareApiError({ status: response.status, operation })),
          );
        });
      return CloudflareApi.of({ request });
    }),
  );

const Tunnel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const DnsRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  content: Schema.String,
  comment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const makeClients = Effect.fn("CloudflareClients.makeClients")(function* (input: {
  readonly accountId: string;
  readonly zoneId: string;
  readonly installationId: string;
  readonly ownerId: string;
  readonly environmentId: string;
}) {
  const api = yield* CloudflareApi;
  const allocations = yield* Allocations.ManagedEndpointAllocations;
  const tunnelPath = `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`;
  const dnsPath = `/zones/${encodeURIComponent(input.zoneId)}/dns_records`;
  const comment = `Supacode installation ${input.installationId}`;
  const ownedTunnel = Effect.fnUntraced(function* (id: string) {
    const allocation = yield* allocations.get({
      userId: input.ownerId,
      environmentId: input.environmentId,
    });
    const tunnel = yield* api.request("GET", `${tunnelPath}/${encodeURIComponent(id)}`, Tunnel);
    if (allocation === null || allocation.tunnelName !== tunnel.name)
      return yield* new CloudflareResourceConflict({ resource: "tunnel" });
    return {
      id: tunnel.id,
      name: tunnel.name,
      ...(tunnel.status ? { status: tunnel.status } : {}),
      ...(tunnel.created_at ? { createdAt: tunnel.created_at } : {}),
    };
  });
  const tunnelFailure =
    (operation: Provider.ManagedEndpointTunnelClientError["operation"]) => (cause: unknown) =>
      new Provider.ManagedEndpointTunnelClientError({ operation, cause });
  const dnsFailure =
    (operation: Provider.ManagedEndpointDnsClientError["operation"]) => (cause: unknown) =>
      new Provider.ManagedEndpointDnsClientError({ operation, cause });
  const ownedDns = Effect.fnUntraced(function* (id: string) {
    const record = yield* api.request("GET", `${dnsPath}/${encodeURIComponent(id)}`, DnsRecord);
    if (record.comment !== comment)
      return yield* new CloudflareResourceConflict({ resource: "dns" });
    return record;
  });
  const tunnels = Provider.ManagedEndpointTunnelClient.of({
    get: (id) => ownedTunnel(id).pipe(Effect.mapError(tunnelFailure("get"))),
    list: (request) =>
      api
        .request(
          "GET",
          `${tunnelPath}?name=${encodeURIComponent(request.name ?? "")}&is_deleted=false`,
          Schema.Array(Tunnel),
        )
        .pipe(
          Effect.map((result) => ({ result })),
          Effect.mapError(tunnelFailure("list")),
        ),
    create: (request) =>
      api
        .request("POST", tunnelPath, Tunnel, { name: request.name, config_src: request.configSrc })
        .pipe(Effect.mapError(tunnelFailure("create"))),
    putConfiguration: (id, config) =>
      ownedTunnel(id).pipe(
        Effect.andThen(
          api.request(
            "PUT",
            `${tunnelPath}/${encodeURIComponent(id)}/configurations`,
            Schema.Unknown,
            { config },
          ),
        ),
        Effect.mapError(tunnelFailure("put-configuration")),
      ),
    getToken: (id) =>
      ownedTunnel(id).pipe(
        Effect.andThen(
          api.request(
            "GET",
            `${tunnelPath}/${encodeURIComponent(id)}/token`,
            Schema.NonEmptyString,
          ),
        ),
        Effect.mapError(tunnelFailure("get-token")),
      ),
    delete: (id) =>
      ownedTunnel(id).pipe(
        Effect.andThen(
          api.request("DELETE", `${tunnelPath}/${encodeURIComponent(id)}`, Schema.Unknown),
        ),
        Effect.mapError(tunnelFailure("delete")),
      ),
  });
  const dns = Provider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      api
        .request("GET", `${dnsPath}?name=${encodeURIComponent(hostname)}`, Schema.Array(DnsRecord))
        .pipe(
          Effect.flatMap((records) =>
            records.some((record) => record.comment !== comment)
              ? Effect.fail(new CloudflareResourceConflict({ resource: "dns" }))
              : Effect.succeed(records),
          ),
          Effect.mapError(dnsFailure("list-records")),
        ),
    createRecord: (record) =>
      api
        .request("POST", dnsPath, DnsRecord, { ...record, comment })
        .pipe(Effect.mapError(dnsFailure("create-record"))),
    updateRecord: (id, record) =>
      ownedDns(id).pipe(
        Effect.andThen(
          api.request("PUT", `${dnsPath}/${encodeURIComponent(id)}`, Schema.Unknown, {
            ...record,
            comment,
          }),
        ),
        Effect.mapError(dnsFailure("update-record")),
      ),
    deleteRecord: (id) =>
      ownedDns(id).pipe(
        Effect.andThen(
          api.request("DELETE", `${dnsPath}/${encodeURIComponent(id)}`, Schema.Unknown),
        ),
        Effect.mapError(dnsFailure("delete-record")),
      ),
  });
  return { tunnels, dns };
});

/** Recover successful remote writes whose responses were lost before journaling.
 * Names include a persisted installation UUID in their digest; DNS also carries
 * an ownership comment. No resources are created during cleanup.
 */
export const recoverForRemoval = Effect.fn("CloudflareClients.recoverForRemoval")(
  function* (input: {
    readonly ownerId: string;
    readonly environmentId: string;
    readonly zoneName: string;
  }) {
    const crypto = yield* Crypto.Crypto;
    const allocations = yield* Allocations.ManagedEndpointAllocations;
    const tunnels = yield* Provider.ManagedEndpointTunnelClient;
    const dns = yield* Provider.ManagedEndpointDnsClient;
    let allocation = yield* allocations.get({
      userId: input.ownerId,
      environmentId: input.environmentId,
    });
    if (allocation === null) {
      const hash = Hex.encode(
        yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput("supacode", input.ownerId, input.environmentId),
          ),
        ),
      );
      allocation = yield* allocations.reserve({
        userId: input.ownerId,
        environmentId: input.environmentId,
        hostname: managedEndpointHostname("supacode", input.zoneName, hash),
        tunnelName: managedEndpointTunnelName("supacode", hash),
      });
    }
    const matches = (yield* tunnels.list({
      name: allocation.tunnelName,
      isDeleted: false,
    })).result.filter((tunnel) => tunnel.name === allocation!.tunnelName);
    if (matches.length > 1) return yield* new CloudflareResourceConflict({ resource: "tunnel" });
    const tunnelId = matches[0]?.id ?? null;
    if (tunnelId !== null && tunnelId !== allocation.tunnelId) {
      const generation = yield* allocations.recordTunnel({
        userId: input.ownerId,
        environmentId: input.environmentId,
        generation: allocation.generation,
        tunnelId,
      });
      if (generation === null) return yield* new CloudflareResourceConflict({ resource: "tunnel" });
      allocation = { ...allocation, generation, tunnelId };
    }
    const records = yield* dns.listRecords(allocation.hostname);
    if (records.length > 1) return yield* new CloudflareResourceConflict({ resource: "dns" });
    const record = records[0];
    if (record !== undefined && record.id !== allocation.dnsRecordId) {
      // recordDns needs a claimed tunnel. If it vanished, retain the old ID for
      // the idempotent deletion and use it to journal the recovered DNS record.
      if (allocation.tunnelId === null) {
        yield* dns.deleteRecord(record.id);
        return;
      }
      const generation = yield* allocations.recordDns({
        userId: input.ownerId,
        environmentId: input.environmentId,
        generation: allocation.generation,
        tunnelId: allocation.tunnelId,
        dnsRecordId: record.id,
      });
      if (generation === null) return yield* new CloudflareResourceConflict({ resource: "dns" });
    }
  },
);
