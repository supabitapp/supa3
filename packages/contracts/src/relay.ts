import * as Schema from "effect/Schema";

export const RelayCompanionRequest = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  action: Schema.Literals(["open", "close"]),
  address: Schema.String.check(Schema.isMaxLength(256)),
});

export const RelayCompanionReply = Schema.Struct({
  id: Schema.String,
  origin: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
