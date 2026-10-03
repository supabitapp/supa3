import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { SupacodeProjectFile, SUPACODE_PROJECT_FILE_SCHEMA_URL } from "@supacode/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `supacode.json` file contents (lenient JSONC string) and the
 * decoded {@link SupacodeProjectFile}.
 */
export const SupacodeProjectFileFromJson = fromLenientJson(SupacodeProjectFile);

const decodeSupacodeProjectFile = Schema.decodeExit(SupacodeProjectFileFromJson);

/**
 * Decode raw `supacode.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseSupacodeProjectFile(contents: string): SupacodeProjectFile | null {
  const decoded = decodeSupacodeProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `supacode.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link SUPACODE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildSupacodeProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in supacode.json.
  const document = Schema.toJsonSchemaDocument(SupacodeProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SUPACODE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
