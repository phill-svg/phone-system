import { createAccessVerifier } from "./verifyAccessJwt";

export type StaffUser = { email: string; role: "admin" | "staff" };

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
    const verify = createAccessVerifier(env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
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
