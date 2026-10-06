import * as Context from "effect/Context";

export class ManagedEndpointConfiguration extends Context.Service<
  ManagedEndpointConfiguration,
  {
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
  }
>()("@supacode/relay/environments/ManagedEndpointConfiguration") {}
