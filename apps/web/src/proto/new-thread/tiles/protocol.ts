import * as Schema from "effect/Schema";

export const TILE_ENDPOINT = "/__proto/tile";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const TileRequest = Schema.Struct({
  prompt: Schema.NonEmptyString.check(Schema.isMaxLength(600)),
  size: Schema.Literals(["s", "m", "t", "l", "w"]),
  width: Schema.Number,
  height: Schema.Number,
  context: Schema.Struct({
    today: Text(80),
    project: Schema.NullOr(Text(200)),
    projects: Schema.Array(Text(200)).check(Schema.isMaxLength(100)),
    models: Schema.Array(Text(120)).check(Schema.isMaxLength(20)),
    summary: Text(600),
  }),
  previous: Schema.NullOr(Schema.Unknown),
});

export type TileRequest = typeof TileRequest.Type;
