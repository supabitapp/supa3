# User-owned relay

Most users should start with [Cloudflare remote access](../../docs/user/remote-access.md#use-your-cloudflare-account).
That path provisions a named tunnel from the environment itself and uses normal
pairing. It needs no Worker, account relay, Clerk deployment, or hosted Supacode
control plane.

This package also retains T3 Connect's account control plane for source deployments.
It provides account discovery, environment linking, proof-bound credentials,
managed tunnel allocation, and optional activity delivery. Application HTTP and
WebSocket traffic goes directly to the selected environment.

The restored implementation follows [upstream 76d3c96](https://github.com/pingdotgg/t3code/tree/76d3c96fd5b89cca2c06aeaceaea16100c75084a/infra/relay).
The local allocation and Cloudflare adapters reuse the same provisioner and
connector protocol. Deployment bindings live beside the provisioner so installing
remote access in a packaged Supacode server does not load Alchemy or PlanetScale.
The database service identities stay shared between the two compositions.

## Local verification

From the repository root:

```sh
vp i
vp test run infra/relay/src/local/provisioner.test.ts infra/relay/src/environments/ManagedEndpointProvider.test.ts
vp exec tsc --noEmit -p infra/relay/tsconfig.json
```

The local tests use isolated SQLite files and mocked Cloudflare HTTP responses.
They cover resource reuse, changed local ports, lost creation responses, ownership
conflicts, and cleanup retries. They do not prove a live Cloudflare deployment.

## Source deployment configuration

The retained Alchemy deployment is an operator profile. Its cloud deployment has
not been exercised against a user account in this change. Review the resources
and provider costs before running it: it includes a Cloudflare Worker, queues,
Hyperdrive, and PlanetScale Postgres, with the upstream `PS_80` cluster and two
replicas. It also requires your own Clerk application and keys. Native account
sign-in, push notifications, and Live Activities in stock Supacode mobile clients
are outside this profile.

`.env.example` lists the relay settings. `RELAY_STANDALONE=true` is the default:
each stage owns its database and adopts DNS zones in your account, without a
reference to an upstream production stage. Set `APNS_ENABLED=true` only when you
have configured your own Apple push credentials. APNs is disabled by default.

The source deployment retains `alchemy deploy` and `alchemy destroy` package
scripts. Use your own Cloudflare and PlanetScale authentication and your own
`RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`, and Clerk JWT audience. Database
retention follows the upstream removal policy. Destroying the stack therefore
requires a separate review of retained database resources.

An environment enables the account profile with
`SUPACODE_CONNECT_RELAY_ENABLED=true`. Configure `T3CODE_RELAY_URL`,
`T3CODE_CLERK_PUBLISHABLE_KEY`, and `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` for your
installation. Headless account authorization additionally requires an explicit
`T3CODE_HOSTED_APP_URL`; there is no upstream hosted-app fallback.

A web source build supplies `VITE_T3CODE_RELAY_URL`,
`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_CLI_OAUTH_CLIENT_ID`, and
`VITE_CLERK_JWT_TEMPLATE` for the same deployment.
Only a fully configured build acquires Clerk and shows the relay account controls
in Connections. Browser access tokens are cached in memory for that session.
These names retain the upstream configuration boundary for subsequent imports.

The restored `supacode connect` CLI links, inspects, unlinks, and signs out of this
configured account profile. A headless link authorizes through your source-built
web client's `/connect` route. Configure the environment's relay profile before
using these commands; the stock `supacode remote` setup uses direct pairing.
