import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://next.supacode.sh",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
