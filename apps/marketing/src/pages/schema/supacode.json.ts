import type { APIRoute } from "astro";

import { buildSupacodeProjectFileJsonSchema } from "@supacode/shared/supacodeProjectFile";

// Rendered at build time; published at https://next.supacode.sh/schema/supacode.json so
// supacode.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildSupacodeProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
