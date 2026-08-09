import type { D1Database, D1Migration, DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    TWILIO_AUTH_TOKEN: string;
    AUDIO_ASSETS: R2Bucket;
    // Untyped: CallSession only exposes plain fetch() (no JSRPC methods), and parameterizing
    // this with the concrete class triggers "Type instantiation is excessively deep" from the
    // Rpc.Provider machinery. Tests cast the instance where needed (see CallSession.test.ts).
    CALL_SESSION: DurableObjectNamespace;
  }
}
