import * as Schema from "effect/Schema";
import { expect } from "@effect/vitest";

const decodeBody = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.String),
    comment: Schema.optionalKey(Schema.String),
    config_src: Schema.optionalKey(Schema.String),
    config: Schema.optionalKey(Schema.Unknown),
  }),
);

export function cloudflare() {
  const tunnels = new Map<string, { id: string; name: string; status: string }>();
  const dns = new Map<
    string,
    { id: string; name: string; type: string; content: string; comment?: string }
  >();
  const requests: { method: string; path: string; body: unknown }[] = [];
  let failAfterTunnelCreate = false;
  let failDnsDelete = false;
  let deny = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.cloudflare.com") {
      expect(url.pathname).toBe("/.well-known/supacode/environment");
      expect(request.headers.get("authorization")).toBeNull();
      return Response.json({
        environmentId: "environment",
        label: "Test",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "26.0.11",
        capabilities: {},
      });
    }
    expect(request.headers.get("authorization")).toBe("Bearer test-management-secret");
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? {}
        : decodeBody(await request.json());
    requests.push({ method: request.method, path: url.pathname, body });
    const reply = (result: unknown, status = 200) =>
      Response.json({ success: status === 200, result }, { status });
    if (deny) return reply({ error: "test-management-secret" }, 403);
    const route = url.pathname.split("/client/v4")[1]!;
    if (route === "/zones/zone") return reply({ name: "example.test", account: { id: "account" } });
    const tunnel = route.match(
      /^\/accounts\/account\/cfd_tunnel(?:\/([^/]+)(?:\/(token|configurations))?)?$/,
    );
    if (tunnel) {
      const id = tunnel[1];
      if (!id && request.method === "GET")
        return reply([...tunnels.values()].filter((t) => t.name === url.searchParams.get("name")));
      if (!id && request.method === "POST") {
        const record = { id: `tunnel-${tunnels.size + 1}`, name: body.name!, status: "inactive" };
        tunnels.set(record.id, record);
        if (failAfterTunnelCreate) {
          failAfterTunnelCreate = false;
          return reply(null, 503);
        }
        return reply(record);
      }
      const record = tunnels.get(id!);
      if (!record) return reply(null, 404);
      if (tunnel[2] === "token") return reply("test-connector-secret");
      if (tunnel[2] === "configurations") return reply({});
      if (request.method === "DELETE") {
        tunnels.delete(id!);
        return reply(null);
      }
      return reply(record);
    }
    const recordRoute = route.match(/^\/zones\/zone\/dns_records(?:\/([^/]+))?$/);
    if (recordRoute) {
      const id = recordRoute[1];
      if (!id && request.method === "GET")
        return reply([...dns.values()].filter((r) => r.name === url.searchParams.get("name")));
      if (!id && request.method === "POST") {
        const record = {
          id: `dns-${dns.size + 1}`,
          name: body.name!,
          type: body.type!,
          content: body.content!,
          ...(body.comment ? { comment: body.comment } : {}),
        };
        dns.set(record.id, record);
        return reply(record);
      }
      const record = dns.get(id!);
      if (!record) return reply(null, 404);
      if (request.method === "DELETE") {
        if (failDnsDelete) return reply(null, 503);
        dns.delete(id!);
        return reply(null);
      }
      if (request.method === "PUT") {
        dns.set(id!, {
          id: id!,
          name: body.name!,
          type: body.type!,
          content: body.content!,
          ...(body.comment ? { comment: body.comment } : {}),
        });
        return reply({});
      }
      return reply(record);
    }
    throw new Error(`Unexpected API request ${request.method} ${route}`);
  };
  return {
    tunnels,
    dns,
    requests,
    fetch,
    setFailAfterCreate: () => {
      failAfterTunnelCreate = true;
    },
    setFailDelete: (value: boolean) => {
      failDnsDelete = value;
    },
    setDeny: () => {
      deny = true;
    },
  };
}
