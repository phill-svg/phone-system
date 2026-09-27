import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { deletePushTokens } from "../../src/db/pushTokens";

// D1 caps a query at 100 bound parameters and miniflare does NOT enforce it, so a plain "delete 150
// tokens" test passes against an unbounded IN list that 500s in production. The test therefore
// wraps the binding and fails any statement that binds more than 100 values itself.
function cappedDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(s, p, r) {
              if (p === "bind") {
                return (...values: unknown[]) => {
                  if (values.length > 100) throw new Error(`too many SQL variables: ${values.length}`);
                  return s.bind(...values);
                };
              }
              const v = Reflect.get(s, p, r);
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("deletePushTokens", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
  });

  it("deletes more tokens than D1's 100-parameter cap without one oversized statement", async () => {
    const tokens = Array.from({ length: 250 }, (_, i) => `ExponentPushToken[t${i}]`);
    await env.DB.batch(
      tokens.map((t) =>
        env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', NULL, 1, 1)").bind(t)
      )
    );
    await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES ('keep', 'ios', NULL, 1, 1)").run();

    await deletePushTokens(cappedDb(env.DB), tokens);

    const left = await env.DB.prepare("SELECT token FROM push_tokens").all<{ token: string }>();
    expect(left.results.map((r) => r.token)).toEqual(["keep"]);
  });
});
