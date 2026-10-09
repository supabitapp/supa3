import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@supacode/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("061_QuestionAutoDismissIndexBackfill", (it) => {
  it.effect("adds the question index to databases already migrated through 60", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`DROP INDEX orchestration_v2_projection_unanswered_questions_created_idx`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 57`;

      assert.deepStrictEqual(yield* runMigrations(), [[61, "QuestionAutoDismissIndexBackfill"]]);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_unanswered_questions_created_idx'`,
        [{ name: "orchestration_v2_projection_unanswered_questions_created_idx" }],
      );
    }),
  );

  it.effect("preserves the question index installed by released migration 57", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const original =
        yield* sql`SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_projection_unanswered_questions_created_idx'`;

      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_projection_unanswered_questions_created_idx'`,
        original,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
