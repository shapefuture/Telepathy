import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false, // the AI binding is remote-only; tests use a stand-in
        miniflare: {
          // The MCP Worker named in wrangler.jsonc isn't part of the tests; history-mcp tests inject their own.
          serviceBindings: { TG_MCP: () => new Response("no MCP server in tests", { status: 503 }) },
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: "123456:TEST",
            WEBHOOK_SECRET: "test-webhook-secret",
            ADMIN_TOKEN: "test-admin-token",
            OWNER_IDS: "1000",
            DEFAULT_LANG: "en", // tests assert English text; production default is "ru"
            // The concierge model runs only remotely (Workers AI), so the cron stays out of it here.
            // test/concierge.test.ts switches it on for its own app.
            CONCIERGE_MODEL: "off",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
