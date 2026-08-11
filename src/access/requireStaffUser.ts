import { createAccessVerifier } from "./verifyAccessJwt";

export type StaffUser = { email: string; role: "admin" | "staff" };

// Module-level cache for the Access JWT verifier. Constructing a verifier calls
// createRemoteJWKSet, which maintains its own internal JWKS cache (fetched from
// Cloudflare's certs endpoint). Recreating the verifier on every request would
// discard that cache and force a re-fetch of the certs on every single request.
// In production there is exactly one real teamDomain/audience pair, so keying
// the cache on `${teamDomain}|${audience}` is safe and avoids that overhead.
let cachedKey: string | undefined;
let cachedVerifier: ReturnType<typeof createAccessVerifier> | undefined;

function getVerifier(teamDomain: string, audience: string): ReturnType<typeof createAccessVerifier> {
  const key = `${teamDomain}|${audience}`;
  if (cachedKey !== key || !cachedVerifier) {
    cachedVerifier = createAccessVerifier(teamDomain, audience);
    cachedKey = key;
  }
  return cachedVerifier;
}

type Env = {
  DB: D1Database;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export async function requireStaffUser(request: Request, env: Env): Promise<StaffUser | Response> {
  let email: string;

  if (env.AUTH_MODE === "dev") {
    if (!env.DEV_STAFF_EMAIL) {
      return new Response("dev auth misconfigured: DEV_STAFF_EMAIL not set", { status: 500 });
    }
    email = env.DEV_STAFF_EMAIL.toLowerCase();
  } else {
    if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
      return new Response("auth misconfigured", { status: 500 });
    }
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) {
      return new Response("unauthenticated", { status: 401 });
    }
    const verify = getVerifier(env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
    const identity = await verify(token);
    if (!identity) {
      return new Response("unauthenticated", { status: 401 });
    }
    email = identity.email;
  }

  const row = await env.DB.prepare("SELECT email, role FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff" }>();

  if (!row) {
    return new Response("not provisioned", { status: 403 });
  }

  return { email: row.email, role: row.role };
}
