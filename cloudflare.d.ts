import type { D1Database, D1Migration } from "@cloudflare/workers-types";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
