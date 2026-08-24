import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      // The vitest-pool-workers isolates are slow to spin up under concurrent load on some
      // machines (many unrelated tests here already run 5-9s), so the 5s default is too tight
      // for the multi-step CallSession scenarios. Give every test more headroom.
      testTimeout: 20000,
      // The mobile app's tests are Jest tests (run via `npm test` inside mobile/); vitest's
      // default include sweeps them up here and they fail on missing jest globals.
      exclude: ["**/node_modules/**", "mobile/**"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              TWILIO_AUTH_TOKEN: "test-auth-token",
              AUTH_MODE: "dev",
              DEV_STAFF_EMAIL: "phill@tcbpestcontrolcanberra.com.au",
              SENDGRID_API_KEY: "SG.test",
              AUTH_FROM_EMAIL: "no-reply@tcbpestcontrolcanberra.com.au",
            },
          },
        },
      },
    },
  };
});
