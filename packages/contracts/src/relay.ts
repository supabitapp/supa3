import * as Schema from "effect/Schema";

const Headers = Schema.Record(Schema.String, Schema.String);
export const RelayRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    path: Schema.String,
    method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    headers: Headers,
    body: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("socket"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("data"), data: Schema.String, binary: Schema.Boolean }),
]);
export const RelayResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    status: Schema.Int,
    headers: Headers,
    body: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("open") }),
  Schema.Struct({ type: Schema.Literal("data"), data: Schema.String, binary: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type RelayRequest = typeof RelayRequest.Type;
export type RelayResponse = typeof RelayResponse.Type;
